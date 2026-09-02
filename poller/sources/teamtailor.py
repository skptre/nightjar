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

TEAMTAILOR_API = "https://{tenant}.teamtailor.com/jobs.json"


class TeamtailorAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = TEAMTAILOR_API.format(tenant=token)

        data = await client.get_json(
            url,
            source="teamtailor",
            company_slug=company.slug,
        )

        if not isinstance(data, dict):
            raise SourceParseError(
                "teamtailor",
                company.slug,
                f"expected object, got {type(data).__name__}",
            )

        jobs = data.get("data", [])
        if not isinstance(jobs, list):
            raise SourceParseError(
                "teamtailor",
                company.slug,
                f"expected 'data' array, got {type(jobs).__name__}",
            )

        included = data.get("included", [])
        lookup = self._build_included_lookup(included)

        postings: list[RawPosting] = []
        for item in jobs:
            try:
                postings.append(self._parse_posting(item, company, token, lookup))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[teamtailor:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[teamtailor:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _build_included_lookup(
        self, included: list[dict[str, Any]] | Any,
    ) -> dict[tuple[str, str], dict[str, Any]]:
        lookup: dict[tuple[str, str], dict[str, Any]] = {}
        if not isinstance(included, list):
            return lookup
        for item in included:
            if isinstance(item, dict):
                key = (item.get("type", ""), str(item.get("id", "")))
                lookup[key] = item.get("attributes", {})
        return lookup

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
        lookup: dict[tuple[str, str], dict[str, Any]],
    ) -> RawPosting:
        job_id = str(item["id"])
        attrs = item.get("attributes", {})
        title = attrs["title"]

        relationships = item.get("relationships", {})

        department: str | None = None
        dept_data = relationships.get("department", {}).get("data")
        if isinstance(dept_data, dict):
            dept_attrs = lookup.get(
                (dept_data.get("type", ""), str(dept_data.get("id", ""))),
                {},
            )
            department = dept_attrs.get("name") or None

        locations_raw: list[str] = []
        loc_entries = relationships.get("locations", {}).get("data", [])
        if isinstance(loc_entries, list):
            for loc_ref in loc_entries:
                if isinstance(loc_ref, dict):
                    loc_attrs = lookup.get(
                        (loc_ref.get("type", ""), str(loc_ref.get("id", ""))),
                        {},
                    )
                    loc_name = loc_attrs.get("name", "")
                    if loc_name:
                        locations_raw.append(loc_name)

        location = locations_raw[0] if locations_raw else ""

        employment_type = attrs.get("employment-type") or None

        remote_status = attrs.get("remote-status", "")
        workplace_type: str | None = None
        if remote_status == "fully":
            workplace_type = "remote"
        elif remote_status == "hybrid":
            workplace_type = "hybrid"

        links = item.get("links", {})
        careers_url = links.get("careersite-job-url", "")
        if not careers_url:
            careers_url = f"https://{board_token}.teamtailor.com/jobs/{job_id}"

        return RawPosting(
            source="teamtailor",
            company_slug=company.slug,
            source_job_id=job_id,
            title=title,
            location=location,
            locations=locations_raw,
            url=careers_url,
            posted_at=attrs.get("created-at"),
            description=attrs.get("body", ""),
            raw_data=item,
            employment_type=employment_type,
            department=department,
            workplace_type=workplace_type,
            updated_at=attrs.get("updated-at"),
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
            source="teamtailor",
            source_job_id=raw.source_job_id,
            ats="teamtailor",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
