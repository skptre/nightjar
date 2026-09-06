from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from poller.descriptions import smartrecruiters_description
from poller.exceptions import SourceParseError
from poller.models import Posting, RawPosting, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, SourceConfig

SMARTRECRUITERS_API = "https://api.smartrecruiters.com/v1/companies"
SMARTRECRUITERS_JOBS = "https://jobs.smartrecruiters.com"
PAGE_LIMIT = 100


class SmartRecruitersAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        base_url = f"{SMARTRECRUITERS_API}/{token}/postings"

        all_postings: list[RawPosting] = []
        offset = 0

        while True:
            data = await client.get_json(
                base_url,
                source="smartrecruiters",
                company_slug=company.slug,
                params={"offset": str(offset), "limit": str(PAGE_LIMIT)},
            )

            if not isinstance(data, dict):
                raise SourceParseError(
                    "smartrecruiters",
                    company.slug,
                    f"expected object, got {type(data).__name__}",
                )

            content = data.get("content", [])
            if not isinstance(content, list):
                raise SourceParseError(
                    "smartrecruiters",
                    company.slug,
                    f"expected 'content' array, got {type(content).__name__}",
                )

            total_found = data.get("totalFound", 0)

            for item in content:
                try:
                    all_postings.append(self._parse_posting(item, company, token))
                except (KeyError, TypeError) as exc:
                    logger.warning(
                        "[smartrecruiters:%s] skipping malformed posting: %s",
                        company.slug, exc,
                    )

            offset += PAGE_LIMIT
            if offset >= total_found or not content:
                break

        logger.info(
            "[smartrecruiters:%s] %d postings from %d total",
            company.slug, len(all_postings), total_found,
        )
        return all_postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        posting_id = item["id"]
        location_obj = item.get("location", {}) or {}
        city = location_obj.get("city", "")
        region = location_obj.get("region", "")
        country = location_obj.get("country", "")

        location_parts = [part for part in (city, region, country) if part]
        location = ", ".join(dict.fromkeys(location_parts))

        locations_list = [location] if location else []

        employment_type_obj = item.get("typeOfEmployment", {})
        employment_type: str | None = None
        if isinstance(employment_type_obj, dict):
            employment_type = employment_type_obj.get("label") or employment_type_obj.get("id")
        elif isinstance(employment_type_obj, str) and employment_type_obj:
            employment_type = employment_type_obj

        dept_obj = item.get("department", {})
        department: str | None = None
        if isinstance(dept_obj, dict):
            department = dept_obj.get("label") or dept_obj.get("id")
        elif isinstance(dept_obj, str) and dept_obj:
            department = dept_obj

        exp_obj = item.get("experienceLevel", {})
        experience_req: str | None = None
        if isinstance(exp_obj, dict):
            experience_req = exp_obj.get("label") or exp_obj.get("id")
        elif isinstance(exp_obj, str) and exp_obj:
            experience_req = exp_obj

        return RawPosting(
            source="smartrecruiters",
            company_slug=company.slug,
            source_job_id=str(posting_id),
            title=item["name"],
            location=location,
            locations=locations_list,
            url=f"{SMARTRECRUITERS_JOBS}/{board_token}/{posting_id}",
            posted_at=item.get("releasedDate"),
            description="",
            raw_data=item,
            employment_type=employment_type,
            department=department,
            experience_requirements=experience_req,
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        pid = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)

        description = smartrecruiters_description(raw.raw_data) or raw.description

        source_meta: dict[str, Any] | None = None
        if raw.experience_requirements:
            source_meta = {"experience_requirements": raw.experience_requirements}

        return Posting(
            id=pid,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="smartrecruiters",
            source_job_id=raw.source_job_id,
            ats="smartrecruiters",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
            source_metadata=source_meta,
        )
