from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import parse_qs, urlparse

from poller.descriptions import (
    description_field,
    lever_description,
    smartrecruiters_description,
    source_facts,
)
from poller.normalize import html_to_plaintext

if TYPE_CHECKING:
    from poller.models import Posting

logger = logging.getLogger(__name__)

DEFAULT_ENRICHMENT_LIMIT = 200
MAX_CONCURRENT = 5
SUPPORTED_ATS = frozenset(
    {
        "greenhouse",
        "lever",
        "ashby",
        "workday",
        "smartrecruiters",
        "workable",
        "icims",
        "jazzhr",
        "rippling",
    }
)

_GREENHOUSE_RE = re.compile(
    r"(?:boards|job-boards)\.(?:eu\.)?greenhouse\.io/([^/]+)/jobs/([^/?#]+)",
    re.IGNORECASE,
)
_LEVER_RE = re.compile(
    r"jobs\.(?:eu\.)?lever\.co/([^/]+)/([^/?#]+)",
    re.IGNORECASE,
)
_ASHBY_RE = re.compile(r"jobs\.ashbyhq\.com/([^/]+)/([^/?#]+)", re.IGNORECASE)
_SMARTRECRUITERS_RE = re.compile(
    r"jobs\.smartrecruiters\.com/([^/]+)/([^/?#]+)",
    re.IGNORECASE,
)
_WORKABLE_RE = re.compile(
    r"apply\.workable\.com/([^/]+)/j/([^/?#]+)",
    re.IGNORECASE,
)
PAGE_ATS = frozenset({"icims", "jazzhr", "rippling"})


def detect_ats_from_url(url: str) -> str | None:
    """Recognize provider hosts and full job paths, never embedded URL substrings."""
    try:
        parsed = urlparse(url)
        if (parsed.scheme not in {"https", "http"} or parsed.username or parsed.password
                or parsed.port not in {None, 80, 443}):
            return None
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    path = parsed.path.strip("/")
    segment = r"[A-Za-z0-9_-]+"
    providers = [
        ("lever", host in {"jobs.lever.co", "jobs.eu.lever.co"},
         rf"{segment}/{segment}(?:/apply)?"),
        ("greenhouse", host in {"boards.greenhouse.io", "job-boards.greenhouse.io",
                               "job-boards.eu.greenhouse.io", "boards.eu.greenhouse.io"},
         rf"{segment}/jobs/{segment}(?:/apply)?"),
        ("ashby", host == "jobs.ashbyhq.com", rf"{segment}/{segment}(?:/application)?"),
        ("smartrecruiters", host == "jobs.smartrecruiters.com", rf"{segment}/{segment}"),
        ("workable", host == "apply.workable.com", rf"{segment}/j/{segment}(?:/apply)?"),
        ("icims", bool(re.fullmatch(r"[a-z0-9-]+\.icims\.com", host)),
         r"jobs/\d+(?:/[^/]+)*"),
        ("jazzhr", bool(re.fullmatch(r"[a-z0-9-]+\.applytojob\.com", host)),
         rf"apply/{segment}(?:/[^/]+)*"),
        ("rippling", host == "ats.rippling.com", rf"{segment}/jobs/{segment}"),
    ]
    for provider, valid_host, shape in providers:
        if valid_host and re.fullmatch(shape, path):
            return provider
    if _workday_detail_url(url):
        return "workday"
    ids = parse_qs(parsed.query).get("gh_jid", [])
    if len(ids) == 1 and re.fullmatch(r"\d+", ids[0]):
        return "greenhouse"
    return None


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
    return html_to_plaintext(value) if isinstance(value, str) else ""


def _workday_detail_url(url: str) -> str | None:
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    host_match = re.fullmatch(r"([^.]+)\.wd\d+\.myworkdayjobs\.com", hostname, re.I)
    if not host_match:
        return None

    segments = [segment for segment in parsed.path.split("/") if segment]
    if (
        len(segments) > 1
        and segments[1] != "job"
        and re.fullmatch(r"[a-z]{2}(?:-[A-Z]{2})?", segments[0], re.I)
    ):
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


async def fetch_description(
    client: JsonClient,
    posting: Posting,
    ashby_cache: dict[str, list[dict[str, Any]]],
    ashby_lock: asyncio.Lock,
    *,
    facts: dict[str, Any] | None = None,
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
            params={"content": "true", "pay_transparency": "true"},
        )
        if (isinstance(data, dict) and data.get("id") is not None
                and str(data["id"]) != match.group(2)):
            raise ValueError("job_identity_mismatch")
        if facts is not None and isinstance(data, dict):
            facts.update(source_facts(data, ats))
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
        if (isinstance(data, dict) and data.get("id") is not None
                and str(data["id"]) != match.group(2)):
            raise ValueError("job_identity_mismatch")
        if facts is not None and isinstance(data, dict):
            facts.update(source_facts(data, ats))
        return lever_description(data) if isinstance(data, dict) else ""

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
        if match_job:
            if facts is not None:
                facts.update(source_facts(match_job, ats))
            return description_field(match_job, "descriptionHtml", "descriptionPlain")
        return ""

    if ats == "workday":
        api_url = _workday_detail_url(posting.url)
        if not api_url:
            return ""
        data = await client.get_json(
            api_url,
            source="description",
            company_slug=posting.company_slug,
        )
        if not isinstance(data, dict):
            return ""
        nested = data.get("jobPostingInfo")
        if isinstance(nested, dict):
            text = _clean_description(nested.get("jobDescription", ""))
            if text:
                return text
        return _clean_description(data.get("jobDescription", ""))

    if ats == "smartrecruiters":
        match = _SMARTRECRUITERS_RE.search(posting.url)
        if not match:
            return ""
        data = await client.get_json(
            f"https://api.smartrecruiters.com/v1/companies/{match.group(1)}/postings/{match.group(2)}",
            source="description",
            company_slug=posting.company_slug,
        )
        return smartrecruiters_description(data) if isinstance(data, dict) else ""

    if ats == "workable":
        match = _WORKABLE_RE.search(posting.url)
        if not match:
            return ""
        tenant, shortcode = match.groups()
        data = await client.get_json(
            f"https://apply.workable.com/api/v1/widget/accounts/{tenant}/jobs/{shortcode}",
            source="description",
            company_slug=posting.company_slug,
        )
        if not isinstance(data, dict) or not _clean_description(data.get("description", "")):
            return ""
        if any(field not in data or not isinstance(data[field], str | type(None))
               for field in ("requirements", "benefits")):
            return ""
        if data.get("shortcode", shortcode) != shortcode:
            return ""
        parts: list[str] = []
        for field in ("description", "requirements", "benefits"):
            value = _clean_description(data.get(field, ""))
            if value:
                parts.append(value if field == "description" else f"{field.title()}\n\n{value}")
        return "\n\n".join(parts)

    if ats in PAGE_ATS and detect_ats_from_url(posting.url) == ats:
        from poller.first_party_details import fetch_first_party, supports_first_party

        if supports_first_party(posting, client):
            text, compensation = await fetch_first_party(posting, client, {}, facts=facts)
            if facts is not None and compensation:
                facts["advertised_compensation"] = compensation
            return text

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
                    client,
                    posting,
                    ashby_cache,
                    ashby_lock,
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
