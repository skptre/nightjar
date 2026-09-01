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

# Microsoft Careers (apply.careers.microsoft.com) is a React/Next.js SPA on
# Adobe AEM as of 2026-09-01. Migrated from jobs.careers.microsoft.com (301).
# No public JSON API found. gcsservices.careers.microsoft.com has certificate
# mismatch. This adapter is a placeholder that will activate if/when Microsoft
# publishes a public API or adds server-side rendering.

ADAPTER_STATUS = "unsupported_spa"


class MicrosoftCareersAdapter(SourceAdapter):
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        raise SourceFetchError(
            "microsoft_careers",
            company.slug,
            "Microsoft Careers is a JavaScript SPA with no verified public "
            "API. Adapter cannot fetch without browser rendering, which is "
            "banned by NJ law.",
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
            source="microsoft_careers",
            source_job_id=raw.source_job_id,
            ats="microsoft_careers",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
        )
