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

COMEET_API = "https://www.comeet.com/careers-api/2.0/company/{uid}/positions"


class ComeetAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = COMEET_API.format(uid=token)

        data = await client.get_json(
            url,
            source="comeet",
            company_slug=company.slug,
        )

        if not isinstance(data, list):
            raise SourceParseError(
                "comeet",
                company.slug,
                f"expected array, got {type(data).__name__}",
            )

        postings: list[RawPosting] = []
        for item in data:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[comeet:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[comeet:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        position_uid = item["uid"]
        title = item["name"]

        location_obj = item.get("location", {}) or {}
        city = ""
        state = ""
        country = ""
        if isinstance(location_obj, dict):
            city = location_obj.get("city", "") or ""
            state = location_obj.get("state", "") or ""
            country = location_obj.get("country", "") or ""
        elif isinstance(location_obj, str):
            city = location_obj

        if city and state:
            location = f"{city}, {state}"
        elif city and country:
            location = f"{city}, {country}"
        elif city:
            location = city
        else:
            location = country or ""

        locations_raw: list[str] = []
        sub_locations = item.get("sub_location", [])
        if isinstance(sub_locations, list) and sub_locations:
            for sub in sub_locations:
                if isinstance(sub, dict):
                    sub_city = sub.get("city", "") or ""
                    sub_state = sub.get("state", "") or ""
                    sub_country = sub.get("country", "") or ""
                    if sub_city and sub_state:
                        locations_raw.append(f"{sub_city}, {sub_state}")
                    elif sub_city and sub_country:
                        locations_raw.append(f"{sub_city}, {sub_country}")
                    elif sub_city:
                        locations_raw.append(sub_city)
        if not locations_raw and location:
            locations_raw = [location]

        department = item.get("department") or None
        employment_type = item.get("time_type") or None

        careers_url = item.get("url_active_page", "")
        if not careers_url:
            careers_url = f"https://www.comeet.com/jobs/{board_token}/{position_uid}"

        return RawPosting(
            source="comeet",
            company_slug=company.slug,
            source_job_id=str(position_uid),
            title=title,
            location=location,
            locations=locations_raw,
            url=careers_url,
            posted_at=item.get("creation_time"),
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
            source="comeet",
            source_job_id=raw.source_job_id,
            ats="comeet",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
        )
