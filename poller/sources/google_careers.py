from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from poller.exceptions import SourceFetchError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

# Google Careers (google.com/about/careers/applications/) is a pure JavaScript
# SPA as of 2026-09-01. No job data in static HTML, no JSON-LD, no public JSON
# API. All known scrapers require browser automation (Selenium/Playwright),
# which violates NJ good-citizen law. This adapter is a placeholder that will
# activate if/when Google publishes a public API or adds server-side rendering.

ADAPTER_STATUS = "unsupported_spa"


class GoogleCareersAdapter(SourceAdapter):
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        raise SourceFetchError(
            "google_careers",
            company.slug,
            "Google Careers is a JavaScript SPA with no public API or "
            "server-rendered content. Adapter cannot fetch without browser "
            "rendering, which is banned by NJ law.",
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        posting_id = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)
        return Posting(
            id=posting_id,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="google_careers",
            source_job_id=raw.source_job_id,
            ats="google_careers",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
