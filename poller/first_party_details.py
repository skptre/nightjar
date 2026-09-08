"""Robots-aware first-party job documents with explicit completeness evidence."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlparse

from poller.exceptions import SourceFetchError
from poller.http import USER_AGENT, is_public_hostname
from poller.page_document import extract_document
from poller.sources.generic import RobotsPolicy

if TYPE_CHECKING:
    from poller.models import Posting

_BLOCKED = ("linkedin.com", "indeed.com", "simplify.jobs")


def supports_first_party(posting: Posting, client: Any) -> bool:
    return _safe_url(posting.url) and callable(getattr(client, "get_text", None))


def _safe_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return False
    host = parsed.hostname or ""
    return (
        parsed.scheme == "https"
        and not parsed.username
        and not parsed.password
        and port in {None, 443}
        and is_public_hostname(host)
        and not any(host == domain or host.endswith("." + domain) for domain in _BLOCKED)
    )


async def _text(
    url: str, posting: Posting, client: Any,
    robots_cache: dict[str, RobotsPolicy] | None,
) -> tuple[str, str]:
    visited: set[str] = set()
    maximum = 5 if robots_cache is None else 3
    for _ in range(maximum + 1):
        if not _safe_url(url) or url in visited:
            raise ValueError("unsafe_or_cyclic_description_redirect")
        visited.add(url)
        if robots_cache is not None:
            parsed = urlparse(url)
            origin = f"https://{parsed.netloc}"
            robot = robots_cache.get(origin)
            if robot is None:
                try:
                    body, _ = await _text(origin + "/robots.txt", posting, client, None)
                except SourceFetchError as exc:
                    if not re.match(r"HTTP (?:404|410)(?:\D|$)", exc.message):
                        raise
                    body = ""
                robot = RobotsPolicy.parse(body)
                robots_cache[origin] = robot
            if not robot.can_fetch(USER_AGENT, url):
                raise ValueError("robots_disallowed")
        try:
            body = await client.get_text(url, source="description",
                                         company_slug=posting.company_slug, follow_redirects=False)
            if not isinstance(body, str) or len(body.encode("utf-8")) > 2_000_000:
                raise ValueError("invalid_or_oversized_description_page")
            return body, url
        except SourceFetchError as exc:
            redirect = re.fullmatch(r"redirect (?:301|302|303|307|308): (.+)", exc.message)
            if not redirect:
                raise
            url = urljoin(url, redirect[1])
    raise ValueError("description_redirect_limit")


async def fetch_first_party(
    posting: Posting, client: Any, robots_cache: dict[str, RobotsPolicy],
    *, facts: dict[str, Any] | None = None,
) -> tuple[str, str | None]:
    html, resolved_url = await _text(posting.url, posting, client, robots_cache)
    document = extract_document(html, resolved_url, posting.title)
    if facts is not None:
        facts["description_acquisition"] = {
            "method": document.method, "completeness": document.status,
            "identity": "matched_url_and_title",
            "resolved_url": resolved_url,
        }
    return document.text, document.compensation
