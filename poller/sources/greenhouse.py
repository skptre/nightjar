from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, html_to_plaintext, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs"


def _extract_location(job: dict[str, Any]) -> str:
    loc = job.get("location")
    if loc is None:
        return ""
    if isinstance(loc, dict):
        name = loc.get("name")
        return normalize_location(name) if name else ""
    return ""


def _extract_locations(job: dict[str, Any]) -> list[str]:
    offices = job.get("offices", [])
    if not offices:
        primary = _extract_location(job)
        return [primary] if primary else []

    raw_locations: list[str] = []
    for office in offices:
        loc = office.get("location", "")
        if loc:
            raw_locations.append(loc)
        elif office.get("name", ""):
            raw_locations.append(office["name"])

    if not raw_locations:
        primary = _extract_location(job)
        return [primary] if primary else []

    return normalize_locations(raw_locations)


class GreenhouseAdapter(SourceAdapter):
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        url = GREENHOUSE_API.format(token=source.board_token)
        data: Any = await client.get_json(
            url,
            source="greenhouse",
            company_slug=company.slug,
            params={"content": "true"},
        )

        if not isinstance(data, dict) or "jobs" not in data:
            raise SourceParseError(
                "greenhouse",
                company.slug,
                f"expected object with 'jobs' key, got {type(data).__name__}",
            )

        jobs = data["jobs"]
        if not isinstance(jobs, list):
            raise SourceParseError(
                "greenhouse",
                company.slug,
                f"expected 'jobs' to be array, got {type(jobs).__name__}",
            )

        raw_postings: list[RawPosting] = []
        for job in jobs:
            try:
                raw_postings.append(self._parse_job(job, company, source))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[greenhouse:%s] skipping malformed job: %s", company.slug, exc
                )

        return raw_postings

    def _parse_job(
        self,
        job: dict[str, Any],
        company: Company,
        source: SourceConfig,
    ) -> RawPosting:
        content_raw = job.get("content", "")
        description = html_to_plaintext(content_raw) if content_raw else ""

        departments = job.get("departments", [])
        department = departments[0]["name"] if departments else None

        metadata = job.get("metadata", []) or []
        employment_type: str | None = None
        for meta in metadata:
            if isinstance(meta, dict) and meta.get("name") == "Employment Type":
                employment_type = meta.get("value")
                break

        return RawPosting(
            source="greenhouse",
            company_slug=company.slug,
            source_job_id=str(job["id"]),
            title=job["title"],
            location=_extract_location(job),
            locations=_extract_locations(job),
            url=job["absolute_url"],
            posted_at=job.get("first_published"),
            description=description,
            raw_data=job,
            employment_type=employment_type,
            department=department,
            updated_at=job.get("updated_at"),
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        posting_id = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)
        return Posting(
            id=posting_id,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="greenhouse",
            source_job_id=raw.source_job_id,
            ats="greenhouse",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            department=raw.department,
        )
