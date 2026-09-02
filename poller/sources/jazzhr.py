from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceParseError
from poller.models import Posting, RawPosting, compute_posting_id
from poller.normalize import clean_title, html_to_plaintext, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, SourceConfig

JAZZHR_API = "https://api.resumatorapi.com/v1/jobs"


class JazzHRAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token

        data = await client.get_json(
            JAZZHR_API,
            source="jazzhr",
            company_slug=company.slug,
            params={"apikey": token, "status": "open"},
        )

        if not isinstance(data, list):
            raise SourceParseError(
                "jazzhr",
                company.slug,
                f"expected array, got {type(data).__name__}",
            )

        postings: list[RawPosting] = []
        for item in data:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[jazzhr:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[jazzhr:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        job_id = item["id"]
        title = item["title"]

        city = item.get("city", "") or ""
        state = item.get("state", "") or ""
        country = item.get("country_id", "") or ""

        if city and state:
            location = f"{city}, {state}"
        elif city:
            location = city
        elif state:
            location = state
        else:
            location = country

        locations_raw = [location] if location else []

        department = item.get("department") or None
        employment_type = item.get("type") or None

        url = f"https://app.jazz.co/app/apply/{board_token}/{job_id}"

        return RawPosting(
            source="jazzhr",
            company_slug=company.slug,
            source_job_id=str(job_id),
            title=title,
            location=location,
            locations=locations_raw,
            url=url,
            posted_at=item.get("original_open_date"),
            description=item.get("description", ""),
            raw_data=item,
            employment_type=employment_type,
            department=department,
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        pid = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)

        description = html_to_plaintext(raw.description) if raw.description else ""

        return Posting(
            id=pid,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="jazzhr",
            source_job_id=raw.source_job_id,
            ats="jazzhr",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
        )
