"""USAJOBS adapter — federal internship/student postings via the official API.

The USAJOBS Search API requires an API key. It is read from the environment
(USAJOBS_API_KEY) so it is NEVER committed to the public repo — inject it as a
GitHub Actions secret / local env var. USAJOBS also requires the requester's
registered email as the User-Agent (USAJOBS_EMAIL).

board_token is the agency `Organization` code (e.g. NASA = "NN"). The adapter
fetches all of an agency's postings; the product-level internship/US filter runs
downstream in filter.py, exactly like every other source.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceFetchError, SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, html_to_plaintext, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

USAJOBS_API = "https://data.usajobs.gov/api/search"
USAJOBS_HOST = "data.usajobs.gov"
PAGE_SIZE = 500

API_KEY_ENV = "USAJOBS_API_KEY"
EMAIL_ENV = "USAJOBS_EMAIL"


DESCRIPTION_FIELDS = (
    ("JobSummary", "Overview"),
    ("MajorDuties", "Responsibilities"),
    ("Requirements", "Requirements"),
    ("Education", "Education"),
    ("Evaluations", "Evaluations"),
    ("RequiredDocuments", "Required documents"),
    ("HowToApply", "How to apply"),
    ("WhatToExpectNext", "What to expect next"),
    ("Benefits", "Benefits"),
    ("OtherInformation", "Additional information"),
)


def _description(descriptor: dict[str, Any]) -> str:
    details = descriptor.get("UserArea", {}).get("Details", {}) or {}
    parts = []
    for key, heading in DESCRIPTION_FIELDS:
        value = details.get(key)
        if isinstance(value, list):
            value = "\n".join(str(item) for item in value)
        if isinstance(value, str) and value.strip():
            parts.append(heading + "\n\n" + html_to_plaintext(value))
    qualifications = descriptor.get("QualificationSummary")
    if isinstance(qualifications, str) and qualifications.strip():
        parts.append("Qualifications\n\n" + html_to_plaintext(qualifications))
    for value in details.get("KeyRequirements", []) or []:
        if isinstance(value, str) and value.strip():
            parts.append("Requirements\n\n" + html_to_plaintext(value))
    return "\n\n".join(parts)


def _extract_locations(descriptor: dict[str, Any]) -> list[str]:
    raw: list[str] = []
    for loc in descriptor.get("PositionLocation", []) or []:
        name = loc.get("LocationName", "") if isinstance(loc, dict) else ""
        if name:
            raw.append(name)
    return normalize_locations(raw)


def _primary_location(descriptor: dict[str, Any], locations: list[str]) -> str:
    display = descriptor.get("PositionLocationDisplay", "") or ""
    # "Multiple Locations" is not a real place; fall back to the first concrete one.
    if display and "multiple" not in display.lower():
        return normalize_location(display)
    return locations[0] if locations else ""


class USAJobsAdapter(SourceAdapter):
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        api_key = os.environ.get(API_KEY_ENV)
        if not api_key:
            # A failed fetch is never an empty result — surface as unhealthy.
            raise SourceFetchError(
                "usajobs",
                company.slug,
                f"{API_KEY_ENV} not set; cannot query USAJOBS",
            )
        email = os.environ.get(EMAIL_ENV)
        if not email:
            raise SourceFetchError("usajobs", company.slug, f"{EMAIL_ENV} not set")
        headers = {
            "Host": USAJOBS_HOST,
            "User-Agent": email,
            "Authorization-Key": api_key,
        }

        all_postings: list[RawPosting] = []
        page = 1
        while True:
            params = {
                "Organization": source.board_token,
                "Fields": "Full",
                "ResultsPerPage": str(PAGE_SIZE),
                "Page": str(page),
            }
            data: Any = await client.get_json(
                USAJOBS_API,
                source="usajobs",
                company_slug=company.slug,
                params=params,
                headers=headers,
            )

            if not isinstance(data, dict) or "SearchResult" not in data:
                raise SourceParseError(
                    "usajobs",
                    company.slug,
                    f"expected object with 'SearchResult', got {type(data).__name__}",
                )

            result = data["SearchResult"]
            if not isinstance(result, dict):
                raise SourceParseError("usajobs", company.slug, "invalid SearchResult")
            items = result.get("SearchResultItems")
            if not isinstance(items, list):
                raise SourceParseError(
                    "usajobs",
                    company.slug,
                    f"expected 'SearchResultItems' array, got {type(items).__name__}",
                )

            for item in items:
                try:
                    all_postings.append(self._parse_job(item, company))
                except (KeyError, TypeError, AttributeError) as exc:
                    raise SourceParseError("usajobs", company.slug, "malformed job item") from exc

            try:
                count_all = int(result["SearchResultCountAll"])
            except (KeyError, TypeError, ValueError) as exc:
                raise SourceParseError("usajobs", company.slug, "invalid total count") from exc
            if count_all < 0 or (not items and len(all_postings) < count_all):
                raise SourceParseError("usajobs", company.slug, "incomplete pagination")

            if not items or len(all_postings) >= count_all:
                break
            page += 1

        return all_postings

    def _parse_job(self, item: dict[str, Any], company: Company) -> RawPosting:
        descriptor = item["MatchedObjectDescriptor"]
        locations = _extract_locations(descriptor)
        location = _primary_location(descriptor, locations)

        description = _description(descriptor)

        categories = descriptor.get("JobCategory", []) or []
        occupational_category = (
            categories[0].get("Name") if categories and isinstance(categories[0], dict) else None
        )

        schedules = descriptor.get("PositionSchedule", []) or []
        employment_type = (
            schedules[0].get("Name") if schedules and isinstance(schedules[0], dict) else None
        )

        return RawPosting(
            source="usajobs",
            company_slug=company.slug,
            source_job_id=str(item["MatchedObjectId"]),
            title=descriptor["PositionTitle"],
            location=location,
            locations=locations,
            url=descriptor["PositionURI"],
            posted_at=descriptor.get("PublicationStartDate"),
            description=description,
            raw_data=item,
            department=descriptor.get("DepartmentName") or descriptor.get("OrganizationName"),
            employment_type=employment_type,
            valid_through=descriptor.get("ApplicationCloseDate"),
            occupational_category=occupational_category,
            requisition_id=descriptor.get("PositionID"),
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        from poller.description_pipeline import DESCRIPTION_VERSION

        posting_id = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)
        details = (
            raw.raw_data.get("MatchedObjectDescriptor", {}).get("UserArea", {}).get("Details", {})
        )
        complete = bool(raw.description) and all(key in details for key, _ in DESCRIPTION_FIELDS)
        return Posting(
            id=posting_id,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="usajobs",
            source_job_id=raw.source_job_id,
            ats="usajobs",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            description_status="available"
            if complete
            else "partial"
            if raw.description
            else "pending",
            description_version=DESCRIPTION_VERSION,
            source_metadata={
                "description_acquisition": {
                    "method": "usajobs_full_api",
                    "identity": "provider_job_endpoint",
                    "completeness": "available" if complete else "partial",
                }
            },
            employment_type=raw.employment_type,
            department=raw.department,
            valid_through=raw.valid_through,
        )
