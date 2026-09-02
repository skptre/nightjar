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

PINPOINT_API = "https://{tenant}.pinpointhq.com/postings.json"


class PinpointAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        token = source.board_token
        url = PINPOINT_API.format(tenant=token)

        data = await client.get_json(
            url,
            source="pinpoint",
            company_slug=company.slug,
        )

        if not isinstance(data, dict):
            raise SourceParseError(
                "pinpoint",
                company.slug,
                f"expected object, got {type(data).__name__}",
            )

        postings_data = data.get("data", [])
        if not isinstance(postings_data, list):
            raise SourceParseError(
                "pinpoint",
                company.slug,
                f"expected 'data' array, got {type(postings_data).__name__}",
            )

        postings: list[RawPosting] = []
        for item in postings_data:
            try:
                postings.append(self._parse_posting(item, company, token))
            except (KeyError, TypeError) as exc:
                logger.warning(
                    "[pinpoint:%s] skipping malformed posting: %s",
                    company.slug, exc,
                )

        logger.info(
            "[pinpoint:%s] %d postings fetched",
            company.slug, len(postings),
        )
        return postings

    def _parse_posting(
        self,
        item: dict[str, Any],
        company: Company,
        board_token: str,
    ) -> RawPosting:
        attrs = item.get("attributes", {})
        posting_id = str(item["id"])
        title = attrs["title"]

        location_name = attrs.get("location_name", "") or ""
        locations_raw = [location_name] if location_name else []

        department = attrs.get("department_name") or None
        employment_type = attrs.get("employment_type") or None

        workplace_type_raw = attrs.get("workplace_type", "") or ""
        workplace_type: str | None = None
        if workplace_type_raw.lower() in ("remote",):
            workplace_type = "remote"
        elif workplace_type_raw.lower() in ("hybrid",):
            workplace_type = "hybrid"

        links = item.get("links", {})
        posting_url = links.get("self", "")
        if not posting_url:
            posting_url = f"https://{board_token}.pinpointhq.com/en/postings/{posting_id}"

        return RawPosting(
            source="pinpoint",
            company_slug=company.slug,
            source_job_id=posting_id,
            title=title,
            location=location_name,
            locations=locations_raw,
            url=posting_url,
            posted_at=attrs.get("published_at"),
            description=attrs.get("description", ""),
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

        description = html_to_plaintext(raw.description) if raw.description else ""

        return Posting(
            id=pid,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="pinpoint",
            source_job_id=raw.source_job_id,
            ats="pinpoint",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=description,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
