from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceFetchError, SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

WORKDAY_PAGE_LIMIT = 20
WORKDAY_PAGE_DELAY_MIN = 1.0
WORKDAY_PAGE_DELAY_MAX = 2.0
WORKDAY_THROTTLE_RETRIES = 3
WORKDAY_THROTTLE_DELAY = 3.0

_BOARD_TOKEN_RE = re.compile(
    r"^(?P<host>(?P<tenant>[^.]+)\.wd\d+\.myworkdayjobs\.com)/(?P<site>.+)$"
)


def parse_board_token(board_token: str) -> tuple[str, str, str]:
    m = _BOARD_TOKEN_RE.match(board_token)
    if not m:
        raise ValueError(f"invalid Workday board_token format: {board_token!r}")
    return m.group("host"), m.group("tenant"), m.group("site")


def _extract_job_id(external_path: str) -> str:
    parts = external_path.rstrip("/").split("/")
    return parts[-1] if parts else external_path


def _extract_location(bullet_fields: list[str]) -> str:
    for field in bullet_fields:
        lower = field.lower().strip()
        if lower.startswith("posted"):
            continue
        skip_values = (
            "full time", "part time", "full-time", "part-time",
            "contract", "temporary", "regular",
        )
        if lower in skip_values:
            continue
        if field.strip():
            return field.strip()
    return ""


class WorkdayAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        host, tenant, site = parse_board_token(source.board_token)
        api_url = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"

        all_postings: list[RawPosting] = []
        offset = 0

        while True:
            body = {
                "appliedFacets": {},
                "limit": WORKDAY_PAGE_LIMIT,
                "offset": offset,
                "searchText": "",
            }

            data = await client.post_json(
                api_url,
                json_body=body,
                source="workday",
                company_slug=company.slug,
            )

            if not isinstance(data, dict):
                raise SourceParseError(
                    "workday",
                    company.slug,
                    f"expected object, got {type(data).__name__}",
                )

            total = data.get("total", 0)
            job_postings = data.get("jobPostings", [])

            if not isinstance(job_postings, list):
                raise SourceParseError(
                    "workday",
                    company.slug,
                    f"expected 'jobPostings' array, got {type(job_postings).__name__}",
                )

            if not job_postings and offset < total:
                job_postings = await self._retry_throttled_page(
                    client, api_url, body, company.slug, total,
                )

            if not job_postings:
                break

            for job in job_postings:
                try:
                    all_postings.append(
                        self._parse_job(job, company, host)
                    )
                except (KeyError, TypeError) as exc:
                    logger.warning(
                        "[workday:%s] skipping malformed job: %s",
                        company.slug, exc,
                    )

            offset += WORKDAY_PAGE_LIMIT

            if offset >= total:
                break

            await asyncio.sleep(
                WORKDAY_PAGE_DELAY_MIN
                + (WORKDAY_PAGE_DELAY_MAX - WORKDAY_PAGE_DELAY_MIN) * 0.5
            )

        logger.info(
            "[workday:%s] %d postings from %d total",
            company.slug, len(all_postings), total if 'total' in dir() else 0,
        )
        return all_postings

    async def _retry_throttled_page(
        self,
        client: RateLimitedClient,
        api_url: str,
        body: dict[str, Any],
        company_slug: str,
        total: int,
    ) -> list[dict[str, Any]]:
        for retry in range(WORKDAY_THROTTLE_RETRIES):
            logger.warning(
                "[workday:%s] empty page at offset=%d but total=%d, "
                "retry %d/%d (likely throttle)",
                company_slug, body["offset"], total,
                retry + 1, WORKDAY_THROTTLE_RETRIES,
            )
            await asyncio.sleep(WORKDAY_THROTTLE_DELAY)

            data = await client.post_json(
                api_url,
                json_body=body,
                source="workday",
                company_slug=company_slug,
            )

            job_postings = data.get("jobPostings", [])
            if job_postings:
                return job_postings  # type: ignore[no-any-return]

        logger.error(
            "[workday:%s] exhausted throttle retries at offset=%d",
            company_slug, body["offset"],
        )
        raise SourceFetchError(
            "workday",
            company_slug,
            f"Workday returned empty page at offset={body['offset']} "
            f"despite total={total} after {WORKDAY_THROTTLE_RETRIES} retries",
        )

    def _parse_job(
        self,
        job: dict[str, Any],
        company: Company,
        host: str,
    ) -> RawPosting:
        external_path = job["externalPath"]
        bullet_fields = job.get("bulletFields", []) or []
        location = str(job.get("locationsText") or "").strip()
        if not location:
            location = _extract_location(bullet_fields)

        employment_type: str | None = None
        for field_val in bullet_fields:
            lower = str(field_val).lower().strip()
            if lower in ("full time", "full-time", "part time", "part-time",
                         "contract", "temporary", "regular"):
                employment_type = lower.replace("-", " ")
                break

        return RawPosting(
            source="workday",
            company_slug=company.slug,
            source_job_id=_extract_job_id(external_path),
            title=job["title"],
            location=location,
            locations=[location] if location else [],
            url=f"https://{host}{external_path}",
            posted_at=None,
            description="",
            raw_data=job,
            employment_type=employment_type,
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
            source="workday",
            source_job_id=raw.source_job_id,
            ats="workday",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
        )
