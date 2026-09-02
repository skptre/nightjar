from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from poller.discovery.common_crawl import format_utc
from poller.discovery.models import BoardCandidate

if TYPE_CHECKING:
    from pathlib import Path

CATALOG_SCHEMA_VERSION = 1
PROMOTABLE_ATS_TYPES = {
    "greenhouse",
    "lever",
    "ashby",
    "smartrecruiters",
}


def _slugify_company(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.casefold()).strip("-")
    return slug or "company"


def load_catalog(path: Path) -> list[BoardCandidate]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != CATALOG_SCHEMA_VERSION:
        raise ValueError("unsupported discovered-board catalog schema")
    candidates = raw.get("candidates")
    if not isinstance(candidates, list):
        raise ValueError("catalog candidates must be a list")
    return [BoardCandidate.from_dict(item) for item in candidates]


def save_catalog(
    path: Path,
    candidates: list[BoardCandidate],
    *,
    generated_at: str | None = None,
    metrics: dict[str, Any] | None = None,
) -> None:
    timestamp = generated_at or format_utc(datetime.now(UTC))
    payload = {
        "schema_version": CATALOG_SCHEMA_VERSION,
        "generated_at": timestamp,
        "metrics": metrics or {},
        "candidates": [
            candidate.to_dict()
            for candidate in sorted(candidates, key=lambda item: item.key)
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def merge_catalog(
    existing: list[BoardCandidate],
    incoming: list[BoardCandidate],
    *,
    now: datetime | None = None,
) -> list[BoardCandidate]:
    timestamp = format_utc(now or datetime.now(UTC))
    merged = {candidate.key: candidate for candidate in existing}

    for candidate in incoming:
        previous = merged.get(candidate.key)
        if previous is None:
            merged[candidate.key] = replace(candidate, last_seen=timestamp)
            continue

        status_from_incoming = candidate.verification_status != "pending"
        merged[candidate.key] = replace(
            previous,
            board_url=candidate.board_url,
            last_seen=timestamp,
            source_urls=sorted(set(previous.source_urls + candidate.source_urls)),
            discovery_sources=sorted(
                set(previous.discovery_sources + candidate.discovery_sources)
            ),
            verification_status=(
                candidate.verification_status
                if status_from_incoming
                else previous.verification_status
            ),
            last_verified=(
                candidate.last_verified
                if status_from_incoming
                else previous.last_verified
            ),
            job_count_at_verification=(
                candidate.job_count_at_verification
                if status_from_incoming
                else previous.job_count_at_verification
            ),
            response_status=(
                candidate.response_status
                if status_from_incoming
                else previous.response_status
            ),
            estimated_poll_cost=(
                candidate.estimated_poll_cost
                if status_from_incoming
                else previous.estimated_poll_cost
            ),
            review_required=(
                candidate.review_required
                if status_from_incoming
                else previous.review_required
            ),
            company_name=candidate.company_name or previous.company_name,
            employer_domain=candidate.employer_domain or previous.employer_domain,
            identity_slug=candidate.identity_slug or previous.identity_slug,
            eu=candidate.eu or previous.eu,
        )

    return sorted(merged.values(), key=lambda item: item.key)


def generate_registry_candidates(
    candidates: list[BoardCandidate],
    *,
    existing: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    output = list(existing or [])
    existing_keys = {
        (
            str(item.get("inferred_ats", "")).casefold(),
            str(item.get("inferred_board_token", "")).casefold(),
        )
        for item in output
    }
    existing_slugs = {str(item.get("slug", "")) for item in output}

    for candidate in sorted(candidates, key=lambda item: item.key):
        if (
            candidate.verification_status != "verified"
            or candidate.review_required
            or candidate.ats_type not in PROMOTABLE_ATS_TYPES
            or candidate.key in existing_keys
        ):
            continue
        name = candidate.company_name or candidate.board_token.split("/", 1)[-1]
        base_slug = _slugify_company(name)
        slug = base_slug
        suffix = 2
        while slug in existing_slugs:
            slug = f"{base_slug}-{suffix}"
            suffix += 1
        entry: dict[str, Any] = {
            "slug": slug,
            "name": name,
            "inferred_ats": candidate.ats_type,
            "inferred_board_token": candidate.board_token,
            "apply_url": candidate.board_url,
            "posting_count": candidate.job_count_at_verification or 0,
            "discovery_source": candidate.discovery_source,
            "verified": True,
        }
        if candidate.eu:
            entry["eu"] = True
        if candidate.identity_slug:
            entry["identity_slug"] = candidate.identity_slug
        output.append(entry)
        existing_keys.add(candidate.key)
        existing_slugs.add(slug)

    return output


def load_registry_candidates(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("registry_candidates.json must contain a list")
    return [dict(item) for item in data if isinstance(item, dict)]


def save_registry_candidates(path: Path, candidates: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(candidates, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
