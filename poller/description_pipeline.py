"""Bounded, persistent collection of public job detail evidence. No applicant decisions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import replace
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse

from poller.description_enrich import (
    DEFAULT_ENRICHMENT_LIMIT,
    MAX_CONCURRENT,
    PAGE_ATS,
    detect_ats_from_url,
    fetch_description,
)
from poller.descriptions import source_facts
from poller.first_party_details import fetch_first_party, supports_first_party

if TYPE_CHECKING:
    from poller.description_enrich import JsonClient
    from poller.models import Company, Posting, RawPosting, SourceConfig
    from poller.sources.generic import RobotsPolicy

DESCRIPTION_VERSION = 5
REFRESH_HOURS = 72
_SEGMENT = re.compile(r"^[A-Za-z0-9_-]+$")


def greenhouse_board_map(companies: list[Company]) -> dict[str, str]:
    """Only unambiguous curated boards can resolve custom-domain job IDs."""
    result = {}
    for company in companies:
        boards = {s.board_token for s in company.sources if s.type == "greenhouse"}
        if len(boards) == 1:
            result[company.slug] = boards.pop()
    return result


def attach_source_context(posting: Posting, raw: RawPosting, source: SourceConfig) -> Posting:
    metadata = {**(posting.source_metadata or {}), **source_facts(raw.raw_data, source.type)}
    if source.type in {"greenhouse", "lever", "ashby", "smartrecruiters", "workable"}:
        metadata["ats_identity"] = {
            "provider": source.type,
            "board": source.board_token,
            "job_id": raw.source_job_id,
            "eu": str(source.eu).lower(),
        }
    # These adapters read complete description fields, not listing-page teasers.
    verified = bool(posting.description_text) and source.type in {
        "greenhouse", "lever", "ashby",
    }
    return replace(
        posting,
        source_metadata=metadata or None,
        description_status="available" if verified else posting.description_status,
        description_version=DESCRIPTION_VERSION if verified else posting.description_version,
    )


def resolve_detail_posting(
    posting: Posting,
    greenhouse_boards: dict[str, str] | None = None,
) -> Posting | None:
    try:
        parsed = urlparse(posting.url)
        if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
                or parsed.port not in {None, 80, 443}):
            return None
    except ValueError:
        return None
    detected = detect_ats_from_url(posting.url)
    ats = detected if posting.ats in {"other", "generic"} and detected else posting.ats
    posting = replace(posting, ats=ats)
    ids = parse_qs(parsed.query).get("gh_jid", [])
    custom_greenhouse = ats == "greenhouse" and parsed.hostname not in {
        "boards.greenhouse.io", "job-boards.greenhouse.io",
        "job-boards.eu.greenhouse.io", "boards.eu.greenhouse.io",
    }
    if detected == ats and not custom_greenhouse:
        return posting
    # Source identity takes precedence over query parameters and company registry hints.
    identity = (posting.source_metadata or {}).get("ats_identity")
    if not isinstance(identity, dict) or identity.get("provider") != ats:
        identity = {}
    board, job_id = identity.get("board"), identity.get("job_id")
    if not identity and custom_greenhouse and len(ids) == 1 and ids[0].isdigit():
        board, job_id = (greenhouse_boards or {}).get(posting.company_slug), ids[0]
    if not (isinstance(board, str) and isinstance(job_id, str)
            and _SEGMENT.fullmatch(board) and _SEGMENT.fullmatch(job_id)):
        return None
    lever_prefix = "eu." if identity.get("eu") == "true" else ""
    paths = {
        "greenhouse": f"https://job-boards.greenhouse.io/{board}/jobs/{job_id}",
        "lever": f"https://jobs.{lever_prefix}lever.co/{board}/{job_id}",
        "ashby": f"https://jobs.ashbyhq.com/{board}/{job_id}",
        "smartrecruiters": f"https://jobs.smartrecruiters.com/{board}/{job_id}",
        "workable": f"https://apply.workable.com/{board}/j/{job_id}/",
    }
    url = paths.get(ats)
    return replace(posting, url=url) if url else None


def _key(posting: Posting) -> str:
    identity = (posting.source_metadata or {}).get("ats_identity")
    return hashlib.sha256(
        json.dumps([posting.ats, posting.url, identity], sort_keys=True).encode()
    ).hexdigest()


async def collect_descriptions(
    postings: list[Posting],
    previous: dict[str, Posting],
    client: JsonClient,
    *,
    state: dict[str, dict[str, Any]],
    now: str,
    limit: int = DEFAULT_ENRICHMENT_LIMIT,
    greenhouse_boards: dict[str, str] | None = None,
) -> tuple[list[Posting], int]:
    current_time = datetime.fromisoformat(now.replace("Z", "+00:00"))

    def later(hours: float) -> str:
        return (current_time + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")

    enriched: list[Posting] = []
    candidates: list[tuple[int, Posting, str]] = []
    for index, posting in enumerate(postings):
        old = previous.get(posting.id)
        carried = bool(old and not posting.description_text and old.description_text)
        if old and not posting.description_text and old.description_text:
            posting = replace(
                posting,
                description_text=old.description_text,
                description_status=old.description_status,
                description_version=old.description_version,
                source_metadata={**(old.source_metadata or {}), **(posting.source_metadata or {})},
            )
        enriched.append(posting)
        if posting.closed_at:
            continue
        target = resolve_detail_posting(posting, greenhouse_boards)
        # A corrected registry board must invalidate the old request's retry schedule.
        key = _key(target or posting)
        attempt = state.get(posting.id, {})
        same = attempt.get("source_key") == key and attempt.get("version") == DESCRIPTION_VERSION
        if same and str(attempt.get("next_attempt_at", "")) > now:
            continue
        # A fresh complete board response already supplies the description; only detail-only
        # records need a separate request. Direct responses are marked by main's adapter path.
        if (
            posting.description_status == "available"
            and posting.description_version == DESCRIPTION_VERSION
            and not same
            and not carried
        ):
            state[posting.id] = {
                "source_key": key,
                "version": DESCRIPTION_VERSION,
                "status": "available",
                "failures": 0,
                "last_success_at": now,
                "next_attempt_at": later(REFRESH_HOURS),
            }
            continue
        if target is None and supports_first_party(posting, client):
            target = posting
        if target is None:
            enriched[index] = replace(
                posting, description_status="stale" if posting.description_text else "unsupported"
            )
            state[posting.id] = {
                "source_key": key, "version": DESCRIPTION_VERSION, "status": "unsupported",
                "error": "unresolved_source_or_unsupported_client",
            }
            continue
        if posting.description_text:
            enriched[index] = replace(posting, description_status="stale")
        if not same:
            state[posting.id] = {
                "source_key": key, "version": DESCRIPTION_VERSION, "status": "pending",
            }
        candidates.append((index, target, key))
    # Oldest attempts first, including never-attempted jobs: advancing queue, no rotating
    # index over a shrinking list and no failed URL monopolizing each batch.
    candidates.sort(
        key=lambda item: (str(state.get(item[1].id, {}).get("last_attempt_at", "")), item[1].id)
    )
    budget = max(0, limit)
    refreshes = [item for item in candidates if state.get(item[1].id, {}).get("last_success_at")]
    reserved = refreshes[:max(1, budget // 4)] if budget else []
    reserved_ids = {item[1].id for item in reserved}
    selected = (reserved + [item for item in candidates if item[1].id not in reserved_ids])[:budget]
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    cache: dict[str, list[dict[str, Any]]] = {}
    lock = asyncio.Lock()
    robots_cache: dict[str, RobotsPolicy] = {}

    async def hydrate(index: int, target: Posting, key: str) -> bool:
        facts: dict[str, Any] = {}
        error = "empty_or_unrecognized_response"
        async with semaphore:
            try:
                text = ""
                api_target = resolve_detail_posting(target)
                if api_target is not None and target.ats not in PAGE_ATS:
                    try:
                        text = await fetch_description(client, target, cache, lock, facts=facts)
                        if text:
                            facts["description_acquisition"] = {
                                "method": f"{target.ats}_api", "completeness": "available",
                                "identity": "provider_job_endpoint",
                            }
                    except Exception:
                        if not supports_first_party(enriched[index], client):
                            raise
                if not text and supports_first_party(enriched[index], client):
                    facts.clear()
                    text, compensation = await fetch_first_party(
                        enriched[index], client, robots_cache, facts=facts)
                    if compensation:
                        facts["advertised_compensation"] = compensation
            except Exception as exc:
                text = ""
                error = type(exc).__name__
                if isinstance(exc, ValueError) and re.fullmatch(r"[a-z_]{1,80}", str(exc)):
                    error = str(exc)
        previous_attempt = state.get(target.id, {})
        entry = {"source_key": key, "version": DESCRIPTION_VERSION, "last_attempt_at": now}
        posting = enriched[index]
        if text:
            acquisition = facts.get("description_acquisition", {})
            status = str(acquisition.get("completeness", "available"))
            state[target.id] = {
                **entry,
                "status": status,
                **({"last_success_at": now} if status == "available" else {
                    "error": "completeness_unverified",
                    **({"last_success_at": previous_attempt["last_success_at"]}
                       if previous_attempt.get("last_success_at") else {}),
                }),
                "failures": 0,
                "next_attempt_at": later(REFRESH_HOURS),
            }
            metadata = {**(posting.source_metadata or {}), **facts}
            # A partial refresh must not erase an earlier complete document.
            old_acquisition = (posting.source_metadata or {}).get("description_acquisition", {})
            old_complete = bool(posting.description_text and posting.description_version
                                and posting.description_status in {"available", "stale"}
                                and old_acquisition.get("completeness") != "partial")
            if status == "partial" and old_complete:
                enriched[index] = replace(posting, description_status="stale")
                return False
            enriched[index] = replace(
                posting,
                description_text=text,
                description_status=status,
                description_version=DESCRIPTION_VERSION,
                source_metadata=metadata or None,
                compensation=facts.get("advertised_compensation") or posting.compensation,
            )
            return status == "available"
        failures = min(int(previous_attempt.get("failures", 0)) + 1, 20)
        state[target.id] = {
            **previous_attempt,
            **entry,
            "status": "failed",
            "error": error,
            "failures": failures,
            "next_attempt_at": later(min(2**failures, 72)),
        }
        enriched[index] = replace(
            posting, description_status="stale" if posting.description_text else "unavailable"
        )
        return False

    results = await asyncio.gather(*(hydrate(*item) for item in selected))
    active_ids = {posting.id for posting in postings}
    for posting_id in list(state):
        if posting_id not in active_ids:
            del state[posting_id]
    return enriched, sum(results)
