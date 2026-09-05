from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlparse

from poller.normalize import html_to_plaintext

if TYPE_CHECKING:
    from poller.models import Posting

logger = logging.getLogger(__name__)

DESCRIPTION_CAP = 5_000
DEFAULT_ENRICHMENT_LIMIT = 200
MAX_CONCURRENT = 5
SUPPORTED_ATS = frozenset({
    "greenhouse",
    "lever",
    "ashby",
    "workday",
    "smartrecruiters",
})

_GREENHOUSE_RE = re.compile(
    r"(?:boards|job-boards)\.greenhouse\.io/([^/]+)/jobs/([^/?#]+)",
    re.IGNORECASE,
)
_LEVER_RE = re.compile(
    r"jobs\.(?:eu\.)?lever\.co/([^/]+)/([^/?#]+)", re.IGNORECASE,
)
_ASHBY_RE = re.compile(r"jobs\.ashbyhq\.com/([^/]+)/([^/?#]+)", re.IGNORECASE)
_SMARTRECRUITERS_RE = re.compile(
    r"jobs\.smartrecruiters\.com/([^/]+)/([^/?#]+)", re.IGNORECASE,
)


class JsonClient(Protocol):
    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        allow_plain_text: bool = False,
        use_conditional: bool = False,
    ) -> Any: ...


def _clean_description(value: str) -> str:
    text = html_to_plaintext(value).strip()
    return text[:DESCRIPTION_CAP]


def _workday_detail_url(url: str) -> str | None:
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    host_match = re.fullmatch(r"([^.]+)\.wd\d+\.myworkdayjobs\.com", hostname, re.I)
    if not host_match:
        return None

    segments = [segment for segment in parsed.path.split("/") if segment]
    if segments and re.fullmatch(r"[a-z]{2}(?:-[A-Z]{2})?", segments[0], re.I):
        segments.pop(0)
    try:
        job_index = segments.index("job")
    except ValueError:
        return None
    if job_index < 1:
        return None

    site = segments[job_index - 1]
    job_path = "/".join(segments[job_index:])
    tenant = host_match.group(1)
    return f"https://{hostname}/wday/cxs/{tenant}/{site}/{job_path}"


def _smartrecruiters_description(data: dict[str, Any]) -> str:
    job_ad = data.get("jobAd")
    if isinstance(job_ad, dict):
        sections = job_ad.get("sections")
        if isinstance(sections, dict):
            parts = [
                section.get("text", "")
                for section in sections.values()
                if isinstance(section, dict) and isinstance(section.get("text"), str)
            ]
            if parts:
                return _clean_description(" ".join(parts))

    legacy = data.get("jobDescription")
    if isinstance(legacy, dict) and isinstance(legacy.get("sections"), list):
        parts = [
            section.get("text", "")
            for section in legacy["sections"]
            if isinstance(section, dict) and isinstance(section.get("text"), str)
        ]
        if parts:
            return _clean_description(" ".join(parts))
    return ""


async def fetch_description(
    client: JsonClient,
    posting: Posting,
    ashby_cache: dict[str, list[dict[str, Any]]],
    ashby_lock: asyncio.Lock,
) -> str:
    ats = posting.ats
    if ats == "greenhouse":
        match = _GREENHOUSE_RE.search(posting.url)
        if not match:
            return ""
        data = await client.get_json(
            f"https://boards-api.greenhouse.io/v1/boards/{match.group(1)}/jobs/{match.group(2)}",
            source="description",
            company_slug=posting.company_slug,
            params={"content": "true"},
        )
        return _clean_description(data.get("content", "")) if isinstance(data, dict) else ""

    if ats == "lever":
        match = _LEVER_RE.search(posting.url)
        if not match:
            return ""
        api_host = "api.eu.lever.co" if ".eu.lever.co" in posting.url else "api.lever.co"
        data = await client.get_json(
            f"https://{api_host}/v0/postings/{match.group(1)}/{match.group(2)}",
            source="description",
            company_slug=posting.company_slug,
        )
        value = data.get("descriptionPlain", "") if isinstance(data, dict) else ""
        return _clean_description(value) if isinstance(value, str) else ""

    if ats == "ashby":
        match = _ASHBY_RE.search(posting.url)
        if not match:
            return ""
        board_slug, job_id = match.groups()
        async with ashby_lock:
            jobs = ashby_cache.get(board_slug)
            if jobs is None:
                data = await client.get_json(
                    f"https://api.ashbyhq.com/posting-api/job-board/{board_slug}",
                    source="description",
                    company_slug=posting.company_slug,
                    params={"includeCompensation": "true"},
                )
                raw_jobs = data.get("jobs", []) if isinstance(data, dict) else []
                jobs = [job for job in raw_jobs if isinstance(job, dict)]
                ashby_cache[board_slug] = jobs
        match_job = next((job for job in jobs if str(job.get("id")) == job_id), None)
        value = match_job.get("descriptionPlain", "") if match_job else ""
        return _clean_description(value) if isinstance(value, str) else ""

    if ats == "workday":
        api_url = _workday_detail_url(posting.url)
        if not api_url:
            return ""
        data = await client.get_json(
            api_url,
            source="description",
            company_slug=posting.company_slug,
        )
        value = data.get("jobDescription", "") if isinstance(data, dict) else ""
        return _clean_description(value) if isinstance(value, str) else ""

    if ats == "smartrecruiters":
        match = _SMARTRECRUITERS_RE.search(posting.url)
        if not match:
            return ""
        data = await client.get_json(
            f"https://api.smartrecruiters.com/v1/companies/{match.group(1)}/postings/{match.group(2)}",
            source="description",
            company_slug=posting.company_slug,
        )
        return _smartrecruiters_description(data) if isinstance(data, dict) else ""

    return ""


async def enrich_posting_descriptions(
    postings: list[Posting],
    previous: dict[str, Posting],
    client: JsonClient,
    *,
    run_number: int,
    limit: int = DEFAULT_ENRICHMENT_LIMIT,
) -> tuple[list[Posting], int]:
    """Carry descriptions forward and backfill a rotating, bounded ATS batch."""
    enriched = [
        replace(posting, description_text=previous[posting.id].description_text)
        if not posting.description_text
        and posting.id in previous
        and previous[posting.id].description_text
        else posting
        for posting in postings
    ]
    candidates = sorted(
        (
            (index, posting)
            for index, posting in enumerate(enriched)
            if not posting.description_text and posting.ats in SUPPORTED_ATS
        ),
        key=lambda item: item[1].id,
    )
    if not candidates or limit <= 0:
        return enriched, 0

    batch_size = min(limit, len(candidates))
    start = (run_number * batch_size) % len(candidates)
    selected = (candidates + candidates)[start : start + batch_size]
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    ashby_cache: dict[str, list[dict[str, Any]]] = {}
    ashby_lock = asyncio.Lock()

    async def hydrate(index: int, posting: Posting) -> tuple[int, str]:
        async with semaphore:
            try:
                return index, await fetch_description(
                    client, posting, ashby_cache, ashby_lock,
                )
            except Exception as exc:  # One stale job must not fail the poller run.
                logger.info(
                    "[description:%s] %s: %s",
                    posting.company_slug,
                    posting.id,
                    exc,
                )
                return index, ""

    results = await asyncio.gather(*(hydrate(index, posting) for index, posting in selected))
    success_count = 0
    for index, description in results:
        if description:
            enriched[index] = replace(enriched[index], description_text=description)
            success_count += 1

    logger.info(
        "description enrichment: %d/%d successful (%d candidates)",
        success_count,
        len(selected),
        len(candidates),
    )
    return enriched, success_count
