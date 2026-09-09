from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

import pytest

from poller.description_enrich import enrich_posting_descriptions, fetch_description
from poller.models import Posting

TS = "2026-09-04T00:00:00Z"


def make_posting(
    posting_id: str,
    *,
    ats: str,
    url: str,
    description: str = "",
) -> Posting:
    return Posting(
        id=posting_id,
        company="Example",
        company_slug="example",
        title="Software Engineer Intern",
        location="New York, NY",
        locations=["New York, NY"],
        url=url,
        source="simplify",
        source_job_id=f"simplify-{posting_id}",
        ats=ats,
        posted_at=None,
        first_seen_at=TS,
        last_seen_at=TS,
        description_text=description,
    )


class FakeClient:
    def __init__(self, responses: dict[str, Any]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, str] | None]] = []

    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        allow_plain_text: bool = False,
        use_conditional: bool = False,
    ) -> Any:
        self.calls.append((url, params))
        return self.responses[url]


@pytest.mark.asyncio
async def test_greenhouse_new_hostname_is_enriched() -> None:
    api_url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123"
    client = FakeClient({api_url: {"content": "<p>Build <b>reliable</b> systems.</p>"}})
    posting = make_posting(
        "gh",
        ats="greenhouse",
        url="https://job-boards.greenhouse.io/acme/jobs/123",
    )

    result = await fetch_description(client, posting, {}, asyncio.Lock())

    assert result == "Build reliable systems."
    assert client.calls == [(api_url, {"content": "true", "pay_transparency": "true"})]


@pytest.mark.asyncio
async def test_ashby_matches_url_job_id_not_simplify_id() -> None:
    api_url = "https://api.ashbyhq.com/posting-api/job-board/acme"
    client = FakeClient({api_url: {
        "jobs": [{"id": "ats-42", "descriptionPlain": "The actual description"}],
    }})
    posting = make_posting(
        "ashby",
        ats="ashby",
        url="https://jobs.ashbyhq.com/acme/ats-42",
    )

    result = await fetch_description(client, posting, {}, asyncio.Lock())

    assert result == "The actual description"


@pytest.mark.asyncio
async def test_workday_builds_site_qualified_cxs_url() -> None:
    api_url = (
        "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/"
        "job/New-York/Intern_R123"
    )
    client = FakeClient({api_url: {"jobDescription": "<p>Workday detail</p>"}})
    posting = make_posting(
        "wd",
        ats="workday",
        url="https://acme.wd5.myworkdayjobs.com/en-US/External/job/New-York/Intern_R123",
    )

    result = await fetch_description(client, posting, {}, asyncio.Lock())

    assert result == "Workday detail"


@pytest.mark.asyncio
async def test_smartrecruiters_reads_documented_job_ad_sections() -> None:
    api_url = "https://api.smartrecruiters.com/v1/companies/Acme/postings/abc"
    client = FakeClient({api_url: {
        "jobAd": {"sections": {
            "jobDescription": {"text": "<p>Build products.</p>"},
            "qualifications": {"text": "<p>Currently enrolled.</p>"},
        }},
    }})
    posting = make_posting(
        "sr",
        ats="smartrecruiters",
        url="https://jobs.smartrecruiters.com/Acme/abc",
    )

    result = await fetch_description(client, posting, {}, asyncio.Lock())

    assert result == "Build products.\n\nCurrently enrolled."


@pytest.mark.asyncio
async def test_enrichment_preserves_success_and_rotates_failures() -> None:
    old = make_posting(
        "old",
        ats="greenhouse",
        url="https://job-boards.greenhouse.io/acme/jobs/1",
        description="Saved detail",
    )
    current_old = replace(old, description_text="")
    missing = make_posting(
        "missing",
        ats="other",
        url="https://example.com/jobs/2",
    )

    result, count = await enrich_posting_descriptions(
        [current_old, missing],
        {old.id: old},
        FakeClient({}),
        run_number=0,
        limit=1,
    )

    assert count == 0
    assert result[0].description_text == "Saved detail"
    assert result[1].description_text == ""


def test_workable_application_url_still_resolves_provider() -> None:
    from poller.description_enrich import detect_ats_from_url
    assert detect_ats_from_url('https://apply.workable.com/example/j/ABC123/apply') == 'workable'
