"""Bounded, persistent collection of public job detail evidence. No applicant decisions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import replace
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from poller.description_enrich import (
    DEFAULT_ENRICHMENT_LIMIT,
    MAX_CONCURRENT,
    _workday_detail_url,
    fetch_description,
)
from poller.descriptions import source_facts
from poller.first_party_details import fetch_first_party, supports_first_party

if TYPE_CHECKING:
    from urllib.robotparser import RobotFileParser

    from poller.description_enrich import JsonClient
    from poller.models import Posting, RawPosting, SourceConfig

DESCRIPTION_VERSION = 2
REFRESH_HOURS = 72
_SEGMENT = re.compile(r"^[A-Za-z0-9_-]+$")


def attach_source_context(posting: Posting, raw: RawPosting, source: SourceConfig) -> Posting:
    metadata = {**(posting.source_metadata or {}), **source_facts(raw.raw_data, source.type)}
    if source.type in {"greenhouse", "lever", "ashby", "smartrecruiters"}:
        metadata["ats_identity"] = {
            "provider": source.type,
            "board": source.board_token,
            "job_id": raw.source_job_id,
            "eu": str(source.eu).lower(),
        }
    # These adapters read complete description fields, not listing-page teasers.
    verified = bool(posting.description_text) and source.type in {"greenhouse", "lever", "ashby"}
    return replace(
        posting,
        source_metadata=metadata or None,
        description_status="available" if verified else posting.description_status,
        description_version=DESCRIPTION_VERSION if verified else posting.description_version,
    )


def resolve_detail_posting(posting: Posting) -> Posting | None:
    parsed = urlparse(posting.url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return None
    allowed = {
        "greenhouse": {"boards.greenhouse.io", "job-boards.greenhouse.io"},
        "lever": {"jobs.lever.co", "jobs.eu.lever.co"},
        "ashby": {"jobs.ashbyhq.com"},
        "smartrecruiters": {"jobs.smartrecruiters.com"},
    }
    path = parsed.path.strip("/")
    shape = (
        r"[^/]+/jobs/[^/]+(?:/apply)?"
        if posting.ats == "greenhouse"
        else r"[^/]+/[^/]+(?:/apply|/application)?"
    )
    if host in allowed.get(posting.ats, set()) and re.fullmatch(shape, path):
        return posting
    if posting.ats == "workday" and _workday_detail_url(posting.url):
        return posting
    identity = (posting.source_metadata or {}).get("ats_identity")
    if not isinstance(identity, dict) or identity.get("provider") != posting.ats:
        return None
    board, job_id = identity.get("board"), identity.get("job_id")
    if not all(isinstance(value, str) and _SEGMENT.fullmatch(value) for value in (board, job_id)):
        return None
    lever_prefix = "eu." if identity.get("eu") == "true" else ""
    paths = {
        "greenhouse": f"https://job-boards.greenhouse.io/{board}/jobs/{job_id}",
        "lever": f"https://jobs.{lever_prefix}lever.co/{board}/{job_id}",
        "ashby": f"https://jobs.ashbyhq.com/{board}/{job_id}",
        "smartrecruiters": f"https://jobs.smartrecruiters.com/{board}/{job_id}",
    }
    url = paths.get(posting.ats)
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
        key = _key(posting)
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
        target = resolve_detail_posting(posting)
        if target is None and supports_first_party(posting, client):
            target = posting
        if target is None:
            enriched[index] = replace(
                posting, description_status="stale" if posting.description_text else "unsupported"
            )
            continue
        candidates.append((index, target, key))
    # Oldest attempts first, including never-attempted jobs: advancing queue, no rotating
    # index over a shrinking list and no failed URL monopolizing each batch.
    candidates.sort(
        key=lambda item: (str(state.get(item[1].id, {}).get("last_attempt_at", "")), item[1].id)
    )
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    cache: dict[str, list[dict[str, Any]]] = {}
    lock = asyncio.Lock()
    robots_cache: dict[str, RobotFileParser] = {}

    async def hydrate(index: int, target: Posting, key: str) -> bool:
        facts: dict[str, Any] = {}
        error = "empty_or_unrecognized_response"
        async with semaphore:
            try:
                if supports_first_party(target, client):
                    text, compensation = await fetch_first_party(target, client, robots_cache)
                    if compensation:
                        facts["advertised_compensation"] = compensation
                else:
                    text = await fetch_description(client, target, cache, lock, facts=facts)
            except Exception as exc:
                text = ""
                error = type(exc).__name__
        previous_attempt = state.get(target.id, {})
        entry = {"source_key": key, "version": DESCRIPTION_VERSION, "last_attempt_at": now}
        posting = enriched[index]
        if text:
            state[target.id] = {
                **entry,
                "status": "available",
                "last_success_at": now,
                "failures": 0,
                "next_attempt_at": later(REFRESH_HOURS),
            }
            metadata = {**(posting.source_metadata or {}), **facts}
            enriched[index] = replace(
                posting,
                description_text=text,
                description_status="available",
                description_version=DESCRIPTION_VERSION,
                source_metadata=metadata or None,
                compensation=facts.get("advertised_compensation") or posting.compensation,
            )
            return True
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

    results = await asyncio.gather(*(hydrate(*item) for item in candidates[: max(0, limit)]))
    active_ids = {posting.id for posting in postings}
    for posting_id in list(state):
        if posting_id not in active_ids:
            del state[posting_id]
    return enriched, sum(results)
