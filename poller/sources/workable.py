from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceParseError
from poller.models import Posting, RawPosting, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, SourceConfig

WORKABLE_API = "https://apply.workable.com/api/v1/widget/accounts/{tenant}"


class WorkableAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = WORKABLE_API.format(tenant=token)

        data = await client.get_json(
            url,
            source="workable",
            company_slug=company.slug,
        )

        if not isinstance(data, dict):
            raise SourceParseError(
                "workable",
                company.slug,
                f"expected object, got {type(data).__name__}",
            )

        jobs = data.get("jobs", [])
        if not isinstance(jobs, list):
            raise SourceParseError(
                "workable",
                company.slug,
                f"expected 'jobs' array, got {type(jobs).__name__}",
            )

        postings: list[RawPosting] = []
        for item in jobs:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[workable:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[workable:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        shortcode = item["shortcode"]
        title = item["title"]

        city = item.get("city", "")
        state = item.get("state", "")
        country = item.get("country", "")

        if city and state:
            location = f"{city}, {state}"
        elif city:
            location = city
        elif state:
            location = state
        else:
            location = country or ""

        locations_raw = [location] if location else []

        department = item.get("department") or None
        employment_type = item.get("employment_type") or None

        remote = item.get("remote", False)
        workplace_type: str | None = None
        if remote or item.get("telecommuting"):
            workplace_type = "remote"

        return RawPosting(
            source="workable",
            company_slug=company.slug,
            source_job_id=shortcode,
            title=title,
            location=location,
            locations=locations_raw,
            url=f"https://apply.workable.com/{board_token}/j/{shortcode}/",
            posted_at=item.get("published_on"),
            description=item.get("description", ""),
            raw_data=item,
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
        pid = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)

        return Posting(
            id=pid,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="workable",
            source_job_id=raw.source_job_id,
            ats="workable",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
