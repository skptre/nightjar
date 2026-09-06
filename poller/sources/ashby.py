from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from poller.descriptions import description_field
from poller.exceptions import SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/{slug}"


def _format_compensation(job: dict[str, Any]) -> str | None:
    if not job.get("shouldDisplayCompensationOnJobPostings"):
        return None

    comp = job.get("compensation")
    if not comp:
        return None

    summary: str | None = comp.get("scrapeableCompensationSalarySummary")
    if summary:
        return summary

    tier_summary: str | None = comp.get("compensationTierSummary")
    if tier_summary:
        return tier_summary

    return None


def _extract_locations(job: dict[str, Any]) -> list[str]:
    raw_locations: list[str] = []

    primary = job.get("location", "")
    if primary:
        raw_locations.append(primary)

    for sec in job.get("secondaryLocations", []):
        loc = sec.get("location", "")
        if loc:
            raw_locations.append(loc)

    return normalize_locations(raw_locations)


class AshbyAdapter(SourceAdapter):
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        url = ASHBY_API.format(slug=source.board_token)
        data: Any = await client.get_json(
            url,
            source="ashby",
            company_slug=company.slug,
            params={"includeCompensation": "true"},
        )

        if not isinstance(data, dict) or "jobs" not in data:
            raise SourceParseError(
                "ashby",
                company.slug,
                f"expected object with 'jobs' key, got {type(data).__name__}",
            )

        jobs = data["jobs"]
        if not isinstance(jobs, list):
            raise SourceParseError(
                "ashby",
                company.slug,
                f"expected 'jobs' to be array, got {type(jobs).__name__}",
            )

        raw_postings: list[RawPosting] = []
        for job in jobs:
            try:
                raw_postings.append(self._parse_job(job, company))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[ashby:%s] skipping malformed job: %s", company.slug, exc
                )

        return raw_postings

    def _parse_job(self, job: dict[str, Any], company: Company) -> RawPosting:
        location = normalize_location(job.get("location", "") or "")
        description = description_field(job, "descriptionHtml", "descriptionPlain")

        employment_type = job.get("employmentType") or None
        department = job.get("department") or None
        is_remote = job.get("isRemote")
        workplace_type: str | None = None
        if is_remote is True:
            workplace_type = "remote"
        elif is_remote is False:
            workplace_type = "onsite"

        return RawPosting(
            source="ashby",
            company_slug=company.slug,
            source_job_id=job["id"],
            title=job["title"],
            location=location,
            locations=_extract_locations(job),
            url=job["jobUrl"],
            posted_at=job.get("publishedAt"),
            description=description,
            raw_data=job,
            compensation=_format_compensation(job),
            employment_type=employment_type,
            department=department,
            workplace_type=workplace_type,
            updated_at=job.get("updatedAt"),
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
            source="ashby",
            source_job_id=raw.source_job_id,
            ats="ashby",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            compensation=raw.compensation,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
