from __future__ import annotations

import logging
from dataclasses import replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

from poller.discovery.common_crawl import canonicalize_board_url
from poller.discovery.directories import normalize_public_domain
from poller.exceptions import SourceFetchError
from poller.http import USER_AGENT

if TYPE_CHECKING:
    from poller.discovery.models import BoardCandidate

logger = logging.getLogger(__name__)

CAREER_PATHS = ("/careers", "/jobs")
MAX_REDIRECTS = 3


class RedirectClient(Protocol):
    async def get_text(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> str: ...

    async def resolve_url(
        self,
        url: str,
        *,
        source: str = "",
        company_slug: str = "",
        max_redirects: int = MAX_REDIRECTS,
    ) -> tuple[str, int]: ...


async def _allowed_paths(client: RedirectClient, domain: str) -> list[str]:
    robots_url = f"https://{domain}/robots.txt"
    try:
        robots_text = await client.get_text(
            robots_url,
            source="redirect",
            company_slug=domain,
        )
    except SourceFetchError as exc:
        logger.warning("redirect discovery skipped %s: robots fetch failed: %s", domain, exc)
        return []

    parser = RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(robots_text.splitlines())
    return [
        path
        for path in CAREER_PATHS
        if parser.can_fetch(USER_AGENT, f"https://{domain}{path}")
    ]


async def discover_redirects(
    domains: list[str],
    client: RedirectClient,
    *,
    now: datetime | None = None,
) -> list[BoardCandidate]:
    run_now = now or datetime.now(UTC)
    candidates: dict[tuple[str, str], BoardCandidate] = {}

    for raw_domain in sorted(set(domains)):
        domain = normalize_public_domain(raw_domain)
        if domain is None:
            continue
        for path in await _allowed_paths(client, domain):
            start_url = f"https://{domain}{path}"
            try:
                final_url, status = await client.resolve_url(
                    start_url,
                    source="redirect",
                    company_slug=domain,
                    max_redirects=MAX_REDIRECTS,
                )
            except SourceFetchError as exc:
                logger.warning("redirect discovery failed for %s: %s", start_url, exc)
                continue
            if status >= 400:
                continue
            candidate = canonicalize_board_url(final_url, "redirect", run_now)
            if candidate is None:
                continue
            source_urls = sorted(set([start_url, final_url, *candidate.source_urls]))
            employer_domain = (urlparse(start_url).hostname or "").casefold()
            candidates[candidate.key] = replace(
                candidate,
                source_urls=source_urls,
                employer_domain=employer_domain,
            )
            break

    return sorted(candidates.values(), key=lambda candidate: candidate.key)
