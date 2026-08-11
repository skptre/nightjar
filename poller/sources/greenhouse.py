from __future__ import annotations

import html
import re
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.sources.base import SourceAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs"


def _unescape_html(text: str) -> str:
    """Iteratively unescape HTML entities until stable.

    Greenhouse double-encodes: &amp;amp; -> &amp; -> &
    We unescape in a loop until the output stops changing.
    """
    previous = ""
    current = text
    for _ in range(5):
        previous = current
        current = html.unescape(current)
        if current == previous:
            break
    return current


def _strip_tags(text: str) -> str:
    """Remove HTML tags and collapse whitespace."""
    stripped = re.sub(r"<[^>]+>", " ", text)
    collapsed = re.sub(r"\s+", " ", stripped)
    return collapsed.strip()


def _html_to_plaintext(raw_html: str) -> str:
    """Convert HTML-entity-encoded content to clean plaintext."""
    unescaped = _unescape_html(raw_html)
    plaintext = _strip_tags(unescaped)
    if len(plaintext) > 5000:
        plaintext = plaintext[:5000]
    return plaintext


def _extract_location(job: dict[str, Any]) -> str:
    """Extract primary location string from a Greenhouse job object."""
    loc = job.get("location")
    if loc is None:
        return ""
    if isinstance(loc, dict):
        name = loc.get("name")
        return name if name else ""
    return ""


def _extract_locations(job: dict[str, Any]) -> list[str]:
    """Extract all location strings from offices array."""
    offices = job.get("offices", [])
    if not offices:
        primary = _extract_location(job)
        return [primary] if primary else []

    locations: list[str] = []
    for office in offices:
        loc = office.get("location", "")
        if loc:
            locations.append(loc)
        elif office.get("name", ""):
            locations.append(office["name"])

    if not locations:
        primary = _extract_location(job)
        return [primary] if primary else []

    return locations


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
                raise SourceParseError(
                    "greenhouse",
                    company.slug,
                    f"malformed job object: {exc}",
                ) from exc

        return raw_postings

    def _parse_job(
        self,
        job: dict[str, Any],
        company: Company,
        source: SourceConfig,
    ) -> RawPosting:
        content_raw = job.get("content", "")
        description = _html_to_plaintext(content_raw) if content_raw else ""

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
            source="greenhouse",
            source_job_id=raw.source_job_id,
            ats="greenhouse",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
        )
