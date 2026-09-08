from __future__ import annotations

import json
from typing import Any

import pytest

from poller.dedupe import dedupe_postings
from poller.description_pipeline import collect_descriptions
from poller.tests.test_description_enrich import make_posting


class PageClient:
    def __init__(self, disallow: bool = False, wrong_job: bool = False) -> None:
        self.calls: list[str] = []
        self.disallow = disallow
        self.wrong_job = wrong_job

    async def get_json(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("JSON-LD fallback should fetch the public document")

    async def get_text(self, url: str, **kwargs: Any) -> str:
        self.calls.append(url)
        assert kwargs["follow_redirects"] is False
        if url.endswith("/robots.txt"):
            return "User-agent: *\nDisallow: /" if self.disallow else "User-agent: *\nAllow: /"
        data = {
            "@type": "JobPosting",
            "title": "Different job" if self.wrong_job else "Software Engineer Intern",
            "url": url,
            "description": "<h2>Requirements</h2><p>Must graduate in 2028.</p>",
        }
        return '<script type="application/ld+json">' + json.dumps(data) + "</script>"


@pytest.mark.asyncio
async def test_first_party_structured_description_and_robots() -> None:
    posting = make_posting("1", ats="other", url="https://careers.example.com/jobs/1")
    client = PageClient()
    rows, count = await collect_descriptions(
        [posting], {}, client, state={}, now="2026-09-06T00:00:00Z"
    )
    assert count == 1
    assert rows[0].description_text == "Requirements\n\nMust graduate in 2028."
    assert rows[0].description_status == "available"


@pytest.mark.asyncio
@pytest.mark.parametrize("disallow,wrong_job", [(True, False), (False, True)])
async def test_robots_or_wrong_job_never_become_success(disallow: bool, wrong_job: bool) -> None:
    posting = make_posting("1", ats="other", url="https://careers.example.com/jobs/1")
    client = PageClient(disallow, wrong_job)
    rows, count = await collect_descriptions(
        [posting], {}, client, state={}, now="2026-09-06T00:00:00Z"
    )
    assert count == 0 and rows[0].description_status == "unavailable"
    if disallow:
        assert len(client.calls) == 1


def test_duplicate_does_not_discard_available_description() -> None:
    from dataclasses import replace

    first = replace(
        make_posting("a", ats="greenhouse", url="https://example.com/job"), source="greenhouse"
    )
    second = make_posting("b", ats="greenhouse", url=first.url, description="Complete description.")
    merged = dedupe_postings([first, second])
    assert len(merged) == 1
    assert merged[0].description_text == second.description_text


@pytest.mark.asyncio
@pytest.mark.parametrize("ats,url", [
    ("icims", "https://careers-acme.icims.com/jobs/123/job"),
    ("jazzhr", "https://acme.applytojob.com/apply/ABC/Intern"),
    ("rippling", "https://ats.rippling.com/acme/jobs/123"),
])
async def test_page_providers_require_matching_structured_job(ats: str, url: str) -> None:
    posting = make_posting("1", ats=ats, url=url)
    for wrong_job in (False, True):
        client = PageClient(wrong_job=wrong_job)
        rows, count = await collect_descriptions(
            [posting], {}, client, state={}, now="2026-09-07T00:00:00Z"
        )
        assert count == (0 if wrong_job else 1)
        assert rows[0].description_status == ("unavailable" if wrong_job else "available")
    client = PageClient(disallow=True)
    rows, count = await collect_descriptions(
        [posting], {}, client, state={}, now="2026-09-07T00:00:00Z"
    )
    assert count == 0 and len(client.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status,success", [(404, True), (410, True), (503, False), (429, False)])
async def test_missing_robots_differs_from_unreachable_robots(status: int, success: bool) -> None:
    from poller.exceptions import SourceFetchError

    class MissingRobots(PageClient):
        async def get_text(self, url: str, **kwargs: Any) -> str:
            if url.endswith("/robots.txt"):
                raise SourceFetchError("description", "example", f"HTTP {status}: unavailable")
            return await super().get_text(url, **kwargs)

    posting = make_posting("1", ats="other", url="https://careers.example.com/jobs/1")
    rows, count = await collect_descriptions([posting], {}, MissingRobots(), state={},
                                            now="2026-09-07T00:00:00Z")
    assert (count == 1) is success
    assert rows[0].description_status == ("available" if success else "unavailable")


@pytest.mark.asyncio
async def test_generic_partial_document_is_not_certified() -> None:
    class HtmlClient(PageClient):
        async def get_text(self, url: str, **kwargs: Any) -> str:
            if url.endswith("/robots.txt"):
                return "User-agent: *\nAllow: /"
            return '<main><h1>Software Engineer Intern</h1><p>You will build software.</p></main>'

    posting = make_posting("1", ats="other", url="https://careers.example.com/jobs/1")
    state: dict[str, dict[str, Any]] = {}
    rows, count = await collect_descriptions([posting], {}, HtmlClient(), state=state,
                                            now="2026-09-07T00:00:00Z")
    assert count == 0
    assert "build software" in rows[0].description_text
    assert rows[0].description_status == state["1"]["status"] == "partial"


@pytest.mark.asyncio
@pytest.mark.parametrize("destination,allowed", [
    ("https://jobs.example.com/job/1", True),
    ("https://127.0.0.1/job/1", False),
    ("https://indeed.com/job/1", False),
])
async def test_bounded_redirect_checks_destination_before_request(
    destination: str, allowed: bool,
) -> None:
    from poller.exceptions import SourceFetchError

    original = "https://careers.example.com/job/1"

    class RedirectClient(PageClient):
        async def get_text(self, url: str, **kwargs: Any) -> str:
            if url == original:
                self.calls.append(url)
                raise SourceFetchError("description", "example", f"redirect 301: {destination}")
            return await super().get_text(url, **kwargs)

    client = RedirectClient()
    rows, count = await collect_descriptions([make_posting("1", ats="other", url=original)],
                                            {}, client, state={}, now="2026-09-07T00:00:00Z")
    assert count == int(allowed)
    assert rows[0].url == original
    if allowed:
        assert "https://jobs.example.com/robots.txt" in client.calls
    else:
        assert destination not in client.calls


@pytest.mark.asyncio
async def test_partial_refresh_keeps_previous_complete_document() -> None:
    posting = make_posting("1", ats="other", url="https://careers.example.com/job/1")
    state: dict[str, dict[str, Any]] = {}
    original, _ = await collect_descriptions([posting], {}, PageClient(), state=state,
                                             now="2026-09-07T00:00:00Z")

    class PartialClient(PageClient):
        async def get_text(self, url: str, **kwargs: Any) -> str:
            if url.endswith("/robots.txt"):
                return "User-agent: *\nAllow: /"
            return '<main><h1>Software Engineer Intern</h1><p>Build software.</p></main>'

    refreshed, count = await collect_descriptions(original, {}, PartialClient(), state=state,
                                                  now="2026-09-11T00:00:00Z")
    assert count == 0
    assert refreshed[0].description_text == original[0].description_text
    assert refreshed[0].description_status == "stale"
    assert state["1"]["status"] == "partial"


@pytest.mark.asyncio
async def test_redirect_destination_robots_can_disallow_collection() -> None:
    from poller.exceptions import SourceFetchError

    class RedirectClient(PageClient):
        async def get_text(self, url: str, **kwargs: Any) -> str:
            if url == "https://careers.example.com/job/1":
                raise SourceFetchError("description", "example",
                                       "redirect 301: https://jobs.example.com/job/1")
            if url == "https://jobs.example.com/robots.txt":
                return "User-agent: *\nDisallow: /"
            return await super().get_text(url, **kwargs)

    client = RedirectClient()
    posting = make_posting("1", ats="other", url="https://careers.example.com/job/1")
    _, count = await collect_descriptions([posting], {}, client, state={},
                                         now="2026-09-07T00:00:00Z")
    assert count == 0
    assert "https://jobs.example.com/job/1" not in client.calls
