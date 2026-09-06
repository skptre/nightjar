from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from poller.descriptions import lever_description
from poller.exceptions import SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

LEVER_API_US = "https://api.lever.co/v0/postings/{slug}"
LEVER_API_EU = "https://api.eu.lever.co/v0/postings/{slug}"
PAGE_SIZE = 100
TRUNCATION_THRESHOLD = 250


def _ms_to_iso(epoch_ms: int | float) -> str:
    """Convert epoch milliseconds to ISO 8601 UTC string."""
    dt = datetime.fromtimestamp(epoch_ms / 1000, tz=UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class LeverAdapter(SourceAdapter):
    def __init__(self) -> None:
        self.potentially_truncated = False

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        self.potentially_truncated = False
        base_url = LEVER_API_EU if source.eu else LEVER_API_US
        url = base_url.format(slug=source.board_token)

        all_postings: list[RawPosting] = []
        skip = 0

        while True:
            params = {"mode": "json", "limit": str(PAGE_SIZE), "skip": str(skip)}
            data: Any = await client.get_json(
                url,
                source="lever",
                company_slug=company.slug,
                params=params,
            )

            if not isinstance(data, list):
                raise SourceParseError(
                    "lever",
                    company.slug,
                    f"expected JSON array, got {type(data).__name__}",
                )

            for job in data:
                try:
                    all_postings.append(self._parse_job(job, company))
                except (KeyError, TypeError) as exc:
                    logger.warning(
                        "[lever:%s] skipping malformed job: %s", company.slug, exc
                    )

            if len(data) < PAGE_SIZE:
                break

            skip += PAGE_SIZE

        if len(all_postings) >= TRUNCATION_THRESHOLD:
            self.potentially_truncated = True

        return all_postings

    def _parse_job(self, job: dict[str, Any], company: Company) -> RawPosting:
        categories = job.get("categories", {}) or {}
        location = normalize_location(categories.get("location", "") or "")
        all_locations = categories.get("allLocations", []) or []
        if not all_locations and location:
            all_locations = [location]
        all_locations = normalize_locations(all_locations)

        created_at = job.get("createdAt")
        posted_at: str | None = None
        if created_at is not None:
            posted_at = _ms_to_iso(created_at)

        description = lever_description(job)

        commitment = categories.get("commitment", "") or ""
        employment_type: str | None = commitment if commitment else None
        department = categories.get("department", "") or None
        workplace_type = (job.get("workplaceType", "") or "").lower() or None

        return RawPosting(
            source="lever",
            company_slug=company.slug,
            source_job_id=job["id"],
            title=job["text"],
            location=location,
            locations=all_locations,
            url=job["hostedUrl"],
            posted_at=posted_at,
            description=description,
            raw_data=job,
            employment_type=employment_type,
            department=department,
            workplace_type=workplace_type,
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
            source="lever",
            source_job_id=raw.source_job_id,
            ats="lever",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
