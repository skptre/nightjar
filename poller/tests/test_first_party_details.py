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
