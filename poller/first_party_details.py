"""Robots-aware first-party job documents with explicit completeness evidence."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlparse

from poller.exceptions import SourceFetchError
from poller.http import USER_AGENT, is_public_hostname
from poller.page_document import (
    JobDocument,
    _Document,
    extract_document,
    normalized_title,
    same_job_url,
    title_is_shortening,
)
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
    url: str,
    posting: Posting,
    client: Any,
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
            body = await client.get_text(
                url, source="description", company_slug=posting.company_slug, follow_redirects=False
            )
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
    posting: Posting,
    client: Any,
    robots_cache: dict[str, RobotsPolicy],
    *,
    facts: dict[str, Any] | None = None,
) -> tuple[str, str | None]:
    html, resolved_url = await _text(posting.url, posting, client, robots_cache)
    from poller.oracle_details import detail_endpoint, parse_detail

    oracle = detail_endpoint(html, resolved_url)
    if oracle:
        body, _ = await _text(oracle[0], posting, client, robots_cache)
        document = parse_detail(body, oracle[1], posting.title)
    else:
        document, resolved_url = await _page_document(
            html, resolved_url, posting, client, robots_cache
        )
    if facts is not None:
        facts["description_acquisition"] = {
            "method": document.method,
            "completeness": document.status,
            "identity": "matched_url_and_title",
            "resolved_url": resolved_url,
        }
    return document.text, document.compensation


async def _page_document(
    html: str,
    resolved_url: str,
    posting: Posting,
    client: Any,
    robots_cache: dict[str, RobotsPolicy],
) -> tuple[JobDocument, str]:
    try:
        document = extract_document(html, resolved_url, posting.title)
    except ValueError as exc:
        if str(exc) != "no_unique_matching_jobposting":
            raise
        # JazzHR publishes both tenant and employer vanity domains. Follow only
        # the page's explicit canonical for the identical application path, once.
        parsed = urlparse(resolved_url)
        tree = _Document(html)
        if re.fullmatch(r"[a-z0-9-]+\.icims\.com", parsed.hostname or ""):
            frames = {
                urljoin(resolved_url, node.attrs.get("src", ""))
                for node in tree.root.walk()
                if node.tag == "iframe"
                and node.attrs.get("id")
                in {"icims_content_iframe", "noscript_icims_content_iframe"}
            }
            if len(frames) == 1:
                frame = frames.pop()
                if frame != resolved_url and _safe_url(frame) and same_job_url(frame, resolved_url):
                    body, actual = await _text(frame, posting, client, robots_cache)
                    if not same_job_url(actual, resolved_url):
                        raise ValueError("icims_frame_identity_mismatch") from exc
                    return extract_document(body, actual, posting.title), actual
        workable = re.fullmatch(r"/([A-Za-z0-9_-]+)/j/([A-Za-z0-9_-]+)(?:/apply)?/?", parsed.path)
        if parsed.hostname == "apply.workable.com" and workable:
            alternate = f"https://apply.workable.com/{workable[1]}/jobs/view/{workable[2]}.md"
            advertised = any(
                node.tag == "link"
                and node.attrs.get("type") == "text/markdown"
                and node.attrs.get("href") == alternate
                for node in tree.root.walk()
            )
            if advertised:
                body, actual = await _text(alternate, posting, client, robots_cache)
                heading = re.search(r"^# ([^\n]+)", body)
                apply_url = f"https://apply.workable.com/{workable[1]}/j/{workable[2]}/apply"
                if (
                    actual != alternate
                    or not heading
                    or apply_url not in body
                    or not title_is_shortening(normalized_title(posting.title), heading[1])
                ):
                    raise ValueError("workable_markdown_identity_mismatch") from exc
                text = re.sub(r"(?m)^#{1,6} +", "", body)
                text = re.sub(r"\*\*([^\n]+?)\*\*", r"\1", text)
                return JobDocument(text.strip(), "partial", "workable_markdown"), actual
        canonicals = {
            urljoin(resolved_url, node.attrs.get("href", ""))
            for node in tree.root.walk()
            if node.tag == "link" and "canonical" in node.attrs.get("rel", "").lower().split()
        }
        if (
            not re.fullmatch(r"[a-z0-9-]+\.applytojob\.com", parsed.hostname or "")
            or not re.match(r"^/apply/[A-Za-z0-9]+/", parsed.path)
            or len(canonicals) != 1
        ):
            raise
        canonical = canonicals.pop()
        target = urlparse(canonical)
        if (
            canonical == resolved_url
            or not _safe_url(canonical)
            or target.path != parsed.path
            or target.query != parsed.query
        ):
            raise
        html, resolved_url = await _text(canonical, posting, client, robots_cache)
        document = extract_document(html, resolved_url, posting.title)
    return document, resolved_url
