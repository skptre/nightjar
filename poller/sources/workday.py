from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceFetchError, SourceParseError
from poller.filter import is_explicitly_non_us, is_student_role, is_us_location
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.pagination import PaginationGuard
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

WORKDAY_PAGE_LIMIT = 20
WORKDAY_PAGE_DELAY_MIN = 1.0
WORKDAY_PAGE_DELAY_MAX = 2.0
WORKDAY_THROTTLE_RETRIES = 3
WORKDAY_THROTTLE_DELAY = 3.0
WORKDAY_RESULT_CAP = 2000

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


def build_public_url(host: str, site: str, external_path: str) -> str:
    """Build a Workday browser URL without losing the career-site segment."""
    path = external_path if external_path.startswith("/") else f"/{external_path}"
    if re.match(rf"^/[a-z]{{2}}(?:-[A-Z]{{2}})?/{re.escape(site)}/job/", path):
        return f"https://{host}{path}"
    if path.startswith(f"/{site}/job/"):
        return f"https://{host}{path}"
    locale_match = re.match(r"^(/[a-z]{2}(?:-[A-Z]{2})?)(/job/.*)$", path)
    if locale_match:
        return f"https://{host}{locale_match.group(1)}/{site}{locale_match.group(2)}"
    return f"https://{host}/{site}{path}"


def _extract_location(bullet_fields: list[str]) -> str:
    for field in bullet_fields:
        lower = field.lower().strip()
        if lower.startswith("posted"):
            continue
        skip_values = (
            "full time",
            "part time",
            "full-time",
            "part-time",
            "contract",
            "temporary",
            "regular",
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
        self.potentially_truncated = False
        self._discovered: dict[str, RawPosting] = {}
        try:
            rows = await self._fetch_partition(client, company, host, site, api_url, {})
        except (SourceFetchError, SourceParseError):
            if not self._discovered:
                raise
            self.potentially_truncated = True
            rows = list(self._discovered.values())
        semaphore = asyncio.Semaphore(4)

        async def resolve(raw: RawPosting) -> None:
            if (
                not is_student_role(raw.title)
                or is_us_location(raw.location, raw.locations)
                or is_explicitly_non_us(raw.location, raw.locations)
            ):
                return
            path = raw.raw_data.get("externalPath", "")
            if not isinstance(path, str) or not path.startswith("/job/"):
                self.potentially_truncated = True
                return
            try:
                async with semaphore:
                    detail = await client.get_json(
                        f"https://{host}/wday/cxs/{tenant}/{site}{path}",
                        source="workday",
                        company_slug=company.slug,
                    )
                info = detail.get("jobPostingInfo", {})
                country = info.get("country", {})
                country_name = country.get("descriptor", "") if isinstance(country, dict) else ""
                primary = str(info.get("location") or "").strip()
                other = info.get("additionalLocations") or []
                if not isinstance(other, list):
                    raise SourceParseError("workday", company.slug, "invalid detail locations")
                locations = [primary] + [x for x in other if isinstance(x, str)]
                locations = [
                    x for x in locations if x and not re.fullmatch(r"\d+ Locations?", x, re.I)
                ]
                if country_name:
                    if not locations:
                        locations = [country_name]
                    elif not is_us_location(locations[0], [locations[0]]):
                        locations[0] = f"{locations[0]}, {country_name}"
                if not locations:
                    self.potentially_truncated = True
                    return
                raw.locations = normalize_locations(locations)
                raw.location = raw.locations[0]
                raw.raw_data["resolved_country"] = country_name
                if not is_us_location(raw.location, raw.locations) and not is_explicitly_non_us(
                    raw.location, raw.locations
                ):
                    self.potentially_truncated = True
            except (SourceFetchError, SourceParseError, ValueError, TypeError, AttributeError):
                # Keep every usable discovery, but never confirm absence from a
                # response whose location-dependent eligibility is unresolved.
                self.potentially_truncated = True

        await asyncio.gather(*(resolve(raw) for raw in rows))
        return rows

    async def _fetch_partition(
        self,
        client: RateLimitedClient,
        company: Company,
        host: str,
        site: str,
        api_url: str,
        facets: dict[str, list[str]],
    ) -> list[RawPosting]:

        all_postings: list[RawPosting] = []
        offset = 0
        guard = PaginationGuard("workday", company.slug, page_size=WORKDAY_PAGE_LIMIT)

        while True:
            body = {
                "appliedFacets": facets,
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

            total = data.get("total")
            if offset == 0 and (isinstance(total, bool) or not isinstance(total, int) or total < 0):
                raise SourceParseError(
                    "workday", company.slug, "missing or invalid first-page total"
                )
            job_postings = data.get("jobPostings")

            if not isinstance(job_postings, list):
                raise SourceParseError(
                    "workday",
                    company.slug,
                    f"expected 'jobPostings' array, got {type(job_postings).__name__}",
                )

            if offset == 0 and isinstance(total, int) and total >= WORKDAY_RESULT_CAP:
                # Workday caps broad searches at 2,000 and may echo page one for
                # out-of-range offsets. Split the search instead of losing its tail.
                return await self._split_capped_search(
                    client,
                    company,
                    host,
                    site,
                    api_url,
                    facets,
                    data,
                )

            expected = max(guard.expected, total) if isinstance(total, int) else guard.expected
            if not job_postings and offset < expected:
                job_postings = await self._retry_throttled_page(
                    client,
                    api_url,
                    body,
                    company.slug,
                    expected,
                )

            page_ids: list[str] = []
            for job in job_postings:
                try:
                    raw = self._parse_job(job, company, host, site)
                    page_ids.append(raw.source_job_id)
                    all_postings.append(raw)
                    if hasattr(self, "_discovered"):
                        self._discovered[raw.source_job_id] = raw
                except (KeyError, TypeError, AttributeError, ValueError) as exc:
                    self.potentially_truncated = True
                    logger.warning(
                        "[workday:%s] skipping malformed job: %s",
                        company.slug,
                        exc,
                    )

            if len(page_ids) != len(job_postings):
                self.potentially_truncated = True
            if guard.observe(page_ids, total, terminal=not job_postings):
                break
            offset += len(job_postings)

            await asyncio.sleep(
                WORKDAY_PAGE_DELAY_MIN + (WORKDAY_PAGE_DELAY_MAX - WORKDAY_PAGE_DELAY_MIN) * 0.5
            )

        logger.info(
            "[workday:%s] %d postings from %d total",
            company.slug,
            len(all_postings),
            guard.expected,
        )
        return list({posting.source_job_id: posting for posting in all_postings}.values())

    async def _split_capped_search(
        self,
        client: RateLimitedClient,
        company: Company,
        host: str,
        site: str,
        api_url: str,
        applied: dict[str, list[str]],
        data: dict[str, Any],
    ) -> list[RawPosting]:
        available = data.get("facets", [])
        if not isinstance(available, list):
            available = []
        preferred = [
            "jobFamilyGroup",
            "locationHierarchy1",
            "Location_Country",
            "Country",
            "locationMainGroup",
            "Location_Region_State_Province",
            "State_Region_Province",
            "jobFamily",
            "timeType",
            "workerSubType",
            "company",
            "Job_Profiles",
        ]
        parameters = preferred + sorted(
            {
                str(f.get("facetParameter"))
                for f in available
                if isinstance(f, dict)
                and f.get("facetParameter")
                and f.get("facetParameter") != "distance"
            }
            - set(preferred)
        )
        for parameter in parameters:
            if parameter in applied:
                continue
            facet = next(
                (
                    f
                    for f in available
                    if isinstance(f, dict) and f.get("facetParameter") == parameter
                ),
                {},
            )
            values = facet.get("values", [])
            if not isinstance(values, list) or len(values) < 2:
                continue
            if not all(
                isinstance(v, dict)
                and isinstance(v.get("id"), str)
                and isinstance(v.get("count"), int)
                and v["count"] > 0
                for v in values
            ):
                continue
            if sum(v["count"] for v in values) < data["total"]:
                continue
            unique: dict[str, RawPosting] = {}
            # Avoid exhausting the budget on a giant retail partition before
            # visiting explicitly advertised student opportunities.
            values = sorted(
                values,
                key=lambda v: (
                    0 if is_student_role(str(v.get("descriptor", ""))) else 1,
                    v["count"],
                    v["id"],
                ),
            )
            logger.info(
                "[workday:%s] partitioning capped search by %s (%d groups)",
                company.slug,
                parameter,
                len(values),
            )
            for value in values:
                try:
                    rows = await self._fetch_partition(
                        client,
                        company,
                        host,
                        site,
                        api_url,
                        {**applied, parameter: [value["id"]]},
                    )
                except (SourceFetchError, SourceParseError):
                    self.potentially_truncated = True
                    rows = list(getattr(self, "_discovered", {}).values())
                if len(rows) < value["count"]:
                    self.potentially_truncated = True
                unique.update((row.source_job_id, row) for row in rows)
            first_page_ids = set()
            for job in data["jobPostings"]:
                try:
                    raw = self._parse_job(job, company, host, site)
                    first_page_ids.add(raw.source_job_id)
                    unique.setdefault(raw.source_job_id, raw)
                except (KeyError, TypeError, ValueError):
                    self.potentially_truncated = True
            if len(unique) < data["total"] or not first_page_ids.issubset(unique):
                self.potentially_truncated = True
            return list(unique.values())
        raise SourceParseError(
            "workday",
            company.slug,
            "search result cap reached without a complete facet partition",
        )

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
                "[workday:%s] empty page at offset=%d but total=%d, retry %d/%d (likely throttle)",
                company_slug,
                body["offset"],
                total,
                retry + 1,
                WORKDAY_THROTTLE_RETRIES,
            )
            await asyncio.sleep(WORKDAY_THROTTLE_DELAY)

            data = await client.post_json(
                api_url,
                json_body=body,
                source="workday",
                company_slug=company_slug,
            )

            if not isinstance(data, dict) or not isinstance(data.get("jobPostings"), list):
                raise SourceParseError("workday", company_slug, "invalid retry page")
            job_postings = data["jobPostings"]
            if job_postings:
                return job_postings  # type: ignore[no-any-return]

        logger.error(
            "[workday:%s] exhausted throttle retries at offset=%d",
            company_slug,
            body["offset"],
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
        site: str = "",
    ) -> RawPosting:
        external_path = job["externalPath"]
        bullet_fields = job.get("bulletFields", []) or []
        location = str(job.get("locationsText") or "").strip()
        if not location:
            location = _extract_location(bullet_fields)

        employment_type: str | None = None
        for field_val in bullet_fields:
            lower = str(field_val).lower().strip()
            if lower in (
                "full time",
                "full-time",
                "part time",
                "part-time",
                "contract",
                "temporary",
                "regular",
            ):
                employment_type = lower.replace("-", " ")
                break

        return RawPosting(
            source="workday",
            company_slug=company.slug,
            source_job_id=_extract_job_id(external_path),
            title=job["title"],
            location=location,
            locations=[location] if location else [],
            url=build_public_url(host, site, external_path)
            if site
            else f"https://{host}{external_path}",
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
