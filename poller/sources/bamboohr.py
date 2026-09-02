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

BAMBOOHR_API = "https://{tenant}.bamboohr.com/careers/list"


class BambooHRAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = BAMBOOHR_API.format(tenant=token)

        data = await client.get_json(
            url,
            source="bamboohr",
            company_slug=company.slug,
        )

        if not isinstance(data, dict):
            raise SourceParseError(
                "bamboohr",
                company.slug,
                f"expected object, got {type(data).__name__}",
            )

        result = data.get("result", [])
        if not isinstance(result, list):
            raise SourceParseError(
                "bamboohr",
                company.slug,
                f"expected 'result' array, got {type(result).__name__}",
            )

        postings: list[RawPosting] = []
        for item in result:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[bamboohr:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[bamboohr:%s] %d postings fetched",
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
        title = item["jobOpeningName"]

        location_obj = item.get("location", {}) or {}
        city = ""
        state = ""
        if isinstance(location_obj, dict):
            city = location_obj.get("city", "")
            state = location_obj.get("state", "")
        elif isinstance(location_obj, str):
            city = location_obj

        if city and state:
            location = f"{city}, {state}"
        elif city:
            location = city
        else:
            location = ""

        locations_raw = [location] if location else []

        department_obj = item.get("department", {})
        department: str | None = None
        if isinstance(department_obj, dict):
            department = department_obj.get("label") or department_obj.get("name")
        elif isinstance(department_obj, str) and department_obj:
            department = department_obj

        employment_status = item.get("employmentStatus") or None

        return RawPosting(
            source="bamboohr",
            company_slug=company.slug,
            source_job_id=str(job_id),
            title=title,
            location=location,
            locations=locations_raw,
            url=f"https://{board_token}.bamboohr.com/careers/{job_id}",
            posted_at=item.get("datePosted"),
            description=item.get("description", ""),
            raw_data=item,
            employment_type=employment_status,
            department=department,
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
            source="bamboohr",
            source_job_id=raw.source_job_id,
            ats="bamboohr",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            department=raw.department,
        )
