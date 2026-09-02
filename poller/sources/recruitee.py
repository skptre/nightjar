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

RECRUITEE_API = "https://{tenant}.recruitee.com/api/offers"


class RecruiteeAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = RECRUITEE_API.format(tenant=token)

        data = await client.get_json(
            url,
            source="recruitee",
            company_slug=company.slug,
        )

        if not isinstance(data, dict):
            raise SourceParseError(
                "recruitee",
                company.slug,
                f"expected object, got {type(data).__name__}",
            )

        offers = data.get("offers", [])
        if not isinstance(offers, list):
            raise SourceParseError(
                "recruitee",
                company.slug,
                f"expected 'offers' array, got {type(offers).__name__}",
            )

        postings: list[RawPosting] = []
        for item in offers:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[recruitee:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[recruitee:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        offer_id = item["id"]
        title = item["title"]

        location = item.get("location", "") or ""
        city = item.get("city", "")
        country = item.get("country", "")
        if not location and city:
            location = f"{city}, {country}" if country else city

        locations_raw: list[str] = []
        offer_locations = item.get("offer_locations", [])
        if isinstance(offer_locations, list):
            for loc in offer_locations:
                if isinstance(loc, dict):
                    loc_city = loc.get("city", "")
                    loc_country = loc.get("country", "")
                    if loc_city:
                        loc_str = f"{loc_city}, {loc_country}" if loc_country else loc_city
                        locations_raw.append(loc_str)
                elif isinstance(loc, str) and loc:
                    locations_raw.append(loc)

        if not locations_raw and location:
            locations_raw = [location]

        department = item.get("department") or None
        employment_type_code = item.get("employment_type_code") or None

        careers_url = item.get("careers_url", "")
        if not careers_url:
            careers_url = f"https://{board_token}.recruitee.com/o/{item.get('slug', offer_id)}"

        return RawPosting(
            source="recruitee",
            company_slug=company.slug,
            source_job_id=str(offer_id),
            title=title,
            location=location,
            locations=locations_raw,
            url=careers_url,
            posted_at=item.get("created_at"),
            description=item.get("description", ""),
            raw_data=item,
            employment_type=employment_type_code,
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
            source="recruitee",
            source_job_id=raw.source_job_id,
            ats="recruitee",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
        )
