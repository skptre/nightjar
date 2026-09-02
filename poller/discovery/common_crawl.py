from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import unquote, urlparse

from poller.discovery.models import BoardCandidate
from poller.exceptions import SourceParseError

logger = logging.getLogger(__name__)

COLLECTIONS_URL = "https://index.commoncrawl.org/collinfo.json"
DEFAULT_CANDIDATE_BUDGET = 500

# [NJ] Block 3 starts as a bounded vertical slice. Do not add patterns here
# until the discover -> verify -> promote loop has measured live success.
POC_QUERY_PATTERNS = (
    "boards.greenhouse.io/*",
    "jobs.lever.co/*",
    "jobs.ashbyhq.com/*",
)

_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_WORKDAY_HOST_RE = re.compile(
    r"^[A-Za-z0-9-]+\.wd\d+\.myworkdayjobs\.com$",
    re.IGNORECASE,
)
_LOCALE_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")


class CommonCrawlClient(Protocol):
    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> Any: ...

    async def get_text(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> str: ...


@dataclass(frozen=True)
class DiscoveryMetrics:
    index_id: str
    query_count: int = 0
    raw_urls: int = 0
    candidates: int = 0
    duplicates: int = 0
    existing_registry: int = 0
    malformed_rows: int = 0
    unrecognized_urls: int = 0
    budget_exhausted: bool = False

    def to_dict(self) -> dict[str, str | int | bool]:
        return {
            "index_id": self.index_id,
            "query_count": self.query_count,
            "raw_urls": self.raw_urls,
            "candidate_count": self.candidates,
            "duplicates": self.duplicates,
            "existing_registry": self.existing_registry,
            "malformed_rows": self.malformed_rows,
            "unrecognized_urls": self.unrecognized_urls,
            "budget_exhausted": self.budget_exhausted,
        }


@dataclass(frozen=True)
class DiscoveryBatch:
    candidates: list[BoardCandidate]
    metrics: DiscoveryMetrics


def format_utc(now: datetime) -> str:
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    return now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_path_segments(path: str) -> list[str] | None:
    decoded = unquote(path)
    if "\\" in decoded:
        return None
    segments = [segment for segment in decoded.split("/") if segment]
    if any(segment in {".", ".."} or not _TOKEN_RE.fullmatch(segment) for segment in segments):
        return None
    return segments


def canonicalize_board_url(
    url: str,
    discovery_source: str,
    now: datetime,
) -> BoardCandidate | None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return None
    host = (parsed.hostname or "").casefold().rstrip(".")
    segments = _safe_path_segments(parsed.path)
    if not host or not segments:
        return None

    ats_type: str
    token: str
    board_url: str
    eu = False

    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"}:
        ats_type = "greenhouse"
        token = segments[0]
        board_url = f"https://boards.greenhouse.io/{token}"
    elif host in {"jobs.lever.co", "jobs.eu.lever.co"}:
        ats_type = "lever"
        token = segments[0]
        eu = host == "jobs.eu.lever.co"
        board_url = f"https://{host}/{token}"
    elif host == "jobs.ashbyhq.com":
        ats_type = "ashby"
        token = segments[0]
        board_url = f"https://jobs.ashbyhq.com/{token}"
    elif _WORKDAY_HOST_RE.fullmatch(host):
        site_index = 1 if _LOCALE_RE.fullmatch(segments[0]) else 0
        if site_index >= len(segments):
            return None
        ats_type = "workday"
        site = segments[site_index]
        token = f"{host}/{site}"
        board_url = f"https://{host}/{site}"
    elif host == "jobs.smartrecruiters.com":
        ats_type = "smartrecruiters"
        token = segments[0]
        board_url = f"https://jobs.smartrecruiters.com/{token}"
    else:
        return None

    timestamp = format_utc(now)
    return BoardCandidate(
        ats_type=ats_type,
        board_token=token,
        board_url=board_url,
        discovery_source=discovery_source,
        first_seen=timestamp,
        last_seen=timestamp,
        source_urls=[url],
        eu=eu,
    )


def _latest_collection(data: Any) -> tuple[str, str]:
    if not isinstance(data, list) or not data:
        raise ValueError("Common Crawl collections response must be a non-empty list")
    latest = data[0]
    if not isinstance(latest, dict):
        raise ValueError("Common Crawl collection entry must be an object")
    index_id = latest.get("id")
    api_url = latest.get("cdx-api")
    if not isinstance(index_id, str) or not isinstance(api_url, str):
        raise ValueError("latest Common Crawl collection lacks id or cdx-api")
    if not api_url.startswith("https://index.commoncrawl.org/"):
        raise ValueError("Common Crawl cdx-api must use the official HTTPS host")
    return index_id, api_url


async def discover_common_crawl(
    client: CommonCrawlClient,
    *,
    known_source_keys: set[tuple[str, str]] | None = None,
    max_candidates: int = DEFAULT_CANDIDATE_BUDGET,
    now: datetime | None = None,
    patterns: tuple[str, ...] = POC_QUERY_PATTERNS,
) -> DiscoveryBatch:
    if max_candidates < 1 or max_candidates > DEFAULT_CANDIDATE_BUDGET:
        raise ValueError("max_candidates must be between 1 and 500")
    if not patterns or any(pattern not in POC_QUERY_PATTERNS for pattern in patterns):
        raise ValueError("only the approved Block 3 PoC query patterns are allowed")

    run_now = now or datetime.now(UTC)
    collections = await client.get_json(
        COLLECTIONS_URL,
        source="common_crawl",
        company_slug="index",
    )
    index_id, index_url = _latest_collection(collections)
    known = {
        (source_type.casefold(), token.casefold())
        for source_type, token in (known_source_keys or set())
    }
    seen: set[tuple[str, str]] = set()
    candidate_pools: list[list[BoardCandidate]] = []
    raw_urls = 0
    duplicates = 0
    existing_registry = 0
    malformed_rows = 0
    unrecognized_urls = 0
    query_count = 0
    budget_exhausted = False

    for pattern in patterns:
        query_count += 1
        pattern_candidates: list[BoardCandidate] = []
        body = await client.get_text(
            index_url,
            source="common_crawl",
            company_slug=index_id,
            params={
                "url": pattern,
                "output": "json",
                "filter": "status:200",
                "collapse": "urlkey",
                "limit": str(max_candidates),
            },
        )
        valid_cdx_rows = 0
        for line in body.splitlines():
            if len(pattern_candidates) >= max_candidates:
                budget_exhausted = True
                break
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                malformed_rows += 1
                continue
            if not isinstance(row, dict) or not isinstance(row.get("url"), str):
                malformed_rows += 1
                continue
            valid_cdx_rows += 1
            raw_urls += 1
            candidate = canonicalize_board_url(row["url"], "common_crawl", run_now)
            if candidate is None:
                unrecognized_urls += 1
                continue
            if candidate.key in known:
                existing_registry += 1
                continue
            if candidate.key in seen:
                duplicates += 1
                continue
            seen.add(candidate.key)
            pattern_candidates.append(candidate)
        if body.strip() and valid_cdx_rows == 0:
            raise SourceParseError(
                "common_crawl",
                index_id,
                f"query for {pattern!r} returned no valid CDX rows",
            )
        candidate_pools.append(pattern_candidates)

    candidates: list[BoardCandidate] = []
    pool_offsets = [0] * len(candidate_pools)
    while len(candidates) < max_candidates:
        added = False
        for index, pool in enumerate(candidate_pools):
            offset = pool_offsets[index]
            if offset >= len(pool):
                continue
            candidates.append(pool[offset])
            pool_offsets[index] += 1
            added = True
            if len(candidates) >= max_candidates:
                break
        if not added:
            break
    if sum(len(pool) for pool in candidate_pools) > max_candidates:
        budget_exhausted = True

    metrics = DiscoveryMetrics(
        index_id=index_id,
        query_count=query_count,
        raw_urls=raw_urls,
        candidates=len(candidates),
        duplicates=duplicates,
        existing_registry=existing_registry,
        malformed_rows=malformed_rows,
        unrecognized_urls=unrecognized_urls,
        budget_exhausted=budget_exhausted,
    )
    logger.info(
        "Common Crawl %s: %d candidates from %d URLs (%d duplicate, %d known)",
        index_id,
        len(candidates),
        raw_urls,
        duplicates,
        existing_registry,
    )
    return DiscoveryBatch(candidates=candidates, metrics=metrics)
