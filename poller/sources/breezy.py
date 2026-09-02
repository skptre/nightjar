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

BREEZY_API = "https://{tenant}.breezy.hr/json"


class BreezyAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = BREEZY_API.format(tenant=token)

        data = await client.get_json(
            url,
            source="breezy",
            company_slug=company.slug,
            params={"verbose": "true"},
        )

        if not isinstance(data, list):
            raise SourceParseError(
                "breezy",
                company.slug,
                f"expected array, got {type(data).__name__}",
            )

        postings: list[RawPosting] = []
        for item in data:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[breezy:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[breezy:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        position_id = item["id"]
        title = item["name"]

        location_obj = item.get("location", {}) or {}
        city = ""
        state = ""
        country = ""
        if isinstance(location_obj, dict):
            city = location_obj.get("city", "")
            state = location_obj.get("state", "")
            country = location_obj.get("country", "")
        elif isinstance(location_obj, str):
            city = location_obj

        if city and state:
            location = f"{city}, {state}"
        elif city:
            location = city
        else:
            location = country or ""

        locations_raw = [location] if location else []

        department = item.get("department") or None
        position_type = item.get("type", {})
        employment_type: str | None = None
        if isinstance(position_type, dict):
            employment_type = position_type.get("name") or position_type.get("id")
        elif isinstance(position_type, str) and position_type:
            employment_type = position_type

        description = item.get("description", "")

        friendly_id = item.get("friendly_id", position_id)
        url = f"https://{board_token}.breezy.hr/p/{friendly_id}"

        return RawPosting(
            source="breezy",
            company_slug=company.slug,
            source_job_id=str(position_id),
            title=title,
            location=location,
            locations=locations_raw,
            url=url,
            posted_at=item.get("published_date"),
            description=description,
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
            source="breezy",
            source_job_id=raw.source_job_id,
            ats="breezy",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
        )
