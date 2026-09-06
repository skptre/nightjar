from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from poller.description_enrich import _workday_detail_url
from poller.description_pipeline import collect_descriptions, resolve_detail_posting
from poller.descriptions import source_facts
from poller.store import RunState
from poller.tests.test_description_enrich import FakeClient, make_posting

URL = "https://job-boards.greenhouse.io/acme/jobs/123"
API = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123"
NOW = "2026-09-06T12:00:00Z"


@pytest.mark.asyncio
async def test_refreshes_retains_on_failure_and_backs_off() -> None:
    posting = make_posting("1", ats="greenhouse", url=URL)
    state: dict[str, dict[str, Any]] = {}
    first, count = await collect_descriptions(
        [posting],
        {},
        FakeClient(
            {
                API: {
                    "content": "<h2>Requirements</h2><p>Graduating 2028.</p>",
                    "pay_input_ranges": [
                        {"min_cents": 3000, "max_cents": 4000, "currency_type": "USD"}
                    ],
                }
            }
        ),
        state=state,
        now=NOW,
    )
    assert count == 1
    assert first[0].description_status == "available"
    assert first[0].source_metadata is not None
    assert first[0].source_metadata["source_compensation"]["provider"] == "greenhouse"
    empty = FakeClient({})
    unchanged, count = await collect_descriptions(
        first, {p.id: p for p in first}, empty, state=state, now="2026-09-06T13:00:00Z"
    )
    assert count == 0 and not empty.calls
    assert unchanged == first
    retained, count = await collect_descriptions(
        first, {p.id: p for p in first}, empty, state=state, now="2026-09-10T12:00:00Z"
    )
    assert count == 0
    assert retained[0].description_text == first[0].description_text
    assert retained[0].description_status == "stale"
    assert state["1"]["failures"] == 1
    calls = len(empty.calls)
    await collect_descriptions(retained, {}, empty, state=state, now="2026-09-10T12:01:00Z")
    assert len(empty.calls) == calls


@pytest.mark.asyncio
async def test_empty_success_is_not_complete_and_fair_queue_advances() -> None:
    state: dict[str, dict[str, Any]] = {}
    jobs = [make_posting(str(i), ats="greenhouse", url=URL) for i in range(3)]
    client = FakeClient({API: {"content": ""}})
    first, _ = await collect_descriptions(jobs, {}, client, state=state, now=NOW, limit=1)
    assert first[0].description_status == "unavailable"
    assert set(state) == {"0"}
    await collect_descriptions(first, {}, client, state=state, now=NOW, limit=1)
    assert set(state) == {"0", "1"}


@pytest.mark.asyncio
async def test_saved_ats_identity_resolves_custom_domain() -> None:
    posting = replace(
        make_posting("1", ats="greenhouse", url="https://acme.com/careers/123"),
        source_metadata={
            "ats_identity": {"provider": "greenhouse", "board": "acme", "job_id": "123"}
        },
    )
    enriched, count = await collect_descriptions(
        [posting],
        {},
        FakeClient(
            {
                API: {
                    "content": "The complete employer description.",
                }
            }
        ),
        state={},
        now=NOW,
    )
    assert count == 1
    assert enriched[0].url == posting.url
    assert enriched[0].description_status == "available"


@pytest.mark.asyncio
async def test_host_lookalikes_and_untrusted_identity_cannot_be_fetched() -> None:
    for url in [
        "https://evil.example/jobs.lever.co/acme/123",
        "https://jobs.lever.co.evil.example/acme/123",
        "https://jobs.lever.co/acme",
    ]:
        client = FakeClient({})
        result, _ = await collect_descriptions(
            [make_posting("1", ats="lever", url=url)], {}, client, state={}, now=NOW
        )
        assert not client.calls
        assert result[0].description_status == "unsupported"


def test_description_state_round_trips() -> None:
    state = RunState(description_attempts={"1": {"status": "failed", "failures": 2}})
    assert RunState.from_dict(state.to_dict()).description_attempts == state.description_attempts


@pytest.mark.asyncio
async def test_changed_url_retries_without_waiting_for_old_failure() -> None:
    posting = make_posting("1", ats="greenhouse", url=URL)
    state: dict[str, dict[str, Any]] = {}
    await collect_descriptions([posting], {}, FakeClient({}), state=state, now=NOW)
    changed = replace(posting, url=URL.replace("123", "456"))
    result, count = await collect_descriptions(
        [changed],
        {},
        FakeClient(
            {
                API.replace("123", "456"): {"content": "Updated employer description."},
            }
        ),
        state=state,
        now=NOW,
    )
    assert count == 1 and result[0].description_status == "available"


@pytest.mark.asyncio
async def test_changed_url_does_not_certify_a_carried_old_description() -> None:
    old = replace(
        make_posting("1", ats="greenhouse", url=URL),
        description_text="Old requirements.",
        description_status="available",
        description_version=2,
    )
    changed = replace(
        old,
        url=URL.replace("123", "456"),
        description_text="",
        description_status=None,
        description_version=None,
    )
    client = FakeClient({API.replace("123", "456"): {"content": "New requirements."}})
    result, count = await collect_descriptions([changed], {old.id: old}, client, state={}, now=NOW)
    assert count == 1
    assert result[0].description_text == "New requirements."


def test_short_workday_site_and_ashby_application_urls_resolve() -> None:
    url = "https://jj.wd5.myworkdayjobs.com/JJ/job/Ohio/Intern_R-123"
    assert (
        _workday_detail_url(url)
        == "https://jj.wd5.myworkdayjobs.com/wday/cxs/jj/JJ/job/Ohio/Intern_R-123"
    )
    posting = make_posting(
        "1", ats="ashby", url="https://jobs.ashbyhq.com/acme/123/application?embed=true"
    )
    assert resolve_detail_posting(posting) == posting


def test_unpublished_compensation_is_not_added_to_public_facts() -> None:
    assert (
        source_facts(
            {"shouldDisplayCompensationOnJobPostings": False, "compensation": {"min": 100}}, "ashby"
        )
        == {}
    )
