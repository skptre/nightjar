from __future__ import annotations

from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.sources.base import SourceAdapter

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
    locations: list[str] = []

    primary = job.get("location", "")
    if primary:
        locations.append(primary)

    for sec in job.get("secondaryLocations", []):
        loc = sec.get("location", "")
        if loc:
            locations.append(loc)

    return locations


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
                raise SourceParseError(
                    "ashby",
                    company.slug,
                    f"malformed job object: {exc}",
                ) from exc

        return raw_postings

    def _parse_job(self, job: dict[str, Any], company: Company) -> RawPosting:
        location = job.get("location", "") or ""
        description = job.get("descriptionPlain", "") or ""

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
            title=raw.title.strip(),
            location=raw.location,
            locations=raw.locations,
            url=raw.url,
            source="ashby",
            source_job_id=raw.source_job_id,
            ats="ashby",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            compensation=raw.compensation,
        )
