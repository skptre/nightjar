"""Conservative first-party JobPosting JSON-LD fallback; never whole-page snippets."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

from poller.http import USER_AGENT, is_public_hostname
from poller.sources.generic import extract_json_ld

if TYPE_CHECKING:
    from poller.models import Posting

_BLOCKED = ("linkedin.com", "indeed.com", "simplify.jobs")


def supports_first_party(posting: Posting, client: Any) -> bool:
    parsed = urlparse(posting.url)
    host = parsed.hostname or ""
    return (
        posting.ats in {"other", "generic"}
        and parsed.scheme == "https"
        and not parsed.username
        and not parsed.password
        and parsed.port in {None, 443}
        and is_public_hostname(host)
        and not any(host == domain or host.endswith("." + domain) for domain in _BLOCKED)
        and callable(getattr(client, "get_text", None))
    )


async def fetch_first_party(
    posting: Posting, client: Any, robots_cache: dict[str, RobotFileParser]
) -> tuple[str, str | None]:
    parsed = urlparse(posting.url)
    origin = f"https://{parsed.netloc}"
    robot = robots_cache.get(origin)
    if robot is None:
        text = await client.get_text(
            origin + "/robots.txt",
            source="description",
            company_slug=posting.company_slug,
            follow_redirects=False,
        )
        robot = RobotFileParser(origin + "/robots.txt")
        robot.parse(text.splitlines())
        robots_cache[origin] = robot
    if not robot.can_fetch(USER_AGENT, posting.url):
        raise ValueError("robots_disallowed")
    html = await client.get_text(
        posting.url, source="description", company_slug=posting.company_slug, follow_redirects=False
    )
    if not isinstance(html, str) or len(html) > 2_000_000:
        raise ValueError("invalid_or_oversized_description_page")
    candidates = extract_json_ld(html, posting.company_slug, posting.url)

    def same_url(value: str) -> bool:
        target = urlparse(value)
        return target.hostname == parsed.hostname and target.path.rstrip("/") == parsed.path.rstrip(
            "/"
        )

    matches = [
        p
        for p in candidates
        if same_url(p.url)
        and " ".join(p.title.lower().split()) == " ".join(posting.title.lower().split())
    ]
    if len(matches) != 1:
        raise ValueError("no_unique_matching_jobposting")
    return matches[0].description, matches[0].compensation
