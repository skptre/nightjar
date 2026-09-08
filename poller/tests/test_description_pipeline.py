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
    assert state["0"]["status"] == "failed"
    assert state["1"]["status"] == state["2"]["status"] == "pending"
    await collect_descriptions(first, {}, client, state=state, now=NOW, limit=1)
    assert state["1"]["status"] == "failed"
    assert state["2"]["status"] == "pending"


@pytest.mark.asyncio
async def test_every_active_job_has_a_collection_outcome_even_without_budget() -> None:
    jobs = [make_posting("1", ats="greenhouse", url=URL),
            make_posting("2", ats="other", url="https://example.com/custom")]
    state: dict[str, dict[str, Any]] = {}
    await collect_descriptions(jobs, {}, FakeClient({}), state=state, now=NOW, limit=0)
    assert set(state) == {"1", "2"}
    assert state["1"]["status"] == "pending"
    assert state["2"]["status"] == "unsupported"


@pytest.mark.asyncio
async def test_api_wrong_job_identifier_is_rejected() -> None:
    posting = make_posting("1", ats="greenhouse", url=URL)
    state: dict[str, dict[str, Any]] = {}
    rows, count = await collect_descriptions([posting], {}, FakeClient({
        API: {"id": 456, "content": "Different job requirements."},
    }), state=state, now=NOW)
    assert count == 0 and not rows[0].description_text
    assert state["1"]["error"] == "job_identity_mismatch"


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


def test_custom_greenhouse_requires_known_board_and_prefers_source_identity() -> None:
    posting = make_posting("1", ats="other", url="https://example.com/jobs?gh_jid=123")
    assert resolve_detail_posting(posting) is None
    target = resolve_detail_posting(posting, {"example": "actual-board"})
    assert target is not None and target.url.endswith("/actual-board/jobs/123")
    posting = replace(posting, source_metadata={"ats_identity": {
        "provider": "greenhouse", "board": "verified-board", "job_id": "456",
    }})
    target = resolve_detail_posting(posting, {"example": "actual-board"})
    assert target is not None and target.url.endswith("/verified-board/jobs/456")


@pytest.mark.parametrize("url", [
    "https://evil.example/ats.rippling.com/acme/jobs/123",
    "https://apply.workable.com.evil.example/acme/j/123",
    "https://careers.icims.com/jobs/123evil",
    "https://acme.applytojob.com/",
    "https://ats.rippling.com/acme",
    "https://jobs.lever.co:invalid/acme/123",
])
def test_new_provider_detection_rejects_invalid_targets(url: str) -> None:
    from poller.description_enrich import detect_ats_from_url

    assert detect_ats_from_url(url) is None
    assert resolve_detail_posting(make_posting("1", ats="other", url=url)) is None


@pytest.mark.asyncio
async def test_workable_detail_preserves_sections_and_ending() -> None:
    from poller.tests.conftest import load_fixture

    posting = make_posting("1", ats="other", url="https://apply.workable.com/acme/j/ABC/")
    client = FakeClient({
        "https://apply.workable.com/api/v1/widget/accounts/acme/jobs/ABC":
            load_fixture("workable", "description_detail"),
    })
    rows, count = await collect_descriptions([posting], {}, client, state={}, now=NOW)
    assert count == 1
    assert rows[0].description_text == (
        "Develop software.\n\nRequirements\n\n- Must be enrolled."
        "\n\nBenefits\n\nHousing is provided."
    )


@pytest.mark.asyncio
async def test_workable_teaser_response_does_not_establish_completeness() -> None:
    posting = make_posting("1", ats="workable", url="https://apply.workable.com/acme/j/ABC/")
    client = FakeClient({
        "https://apply.workable.com/api/v1/widget/accounts/acme/jobs/ABC": {
            "description": "Listing excerpt.",
        },
    })
    rows, count = await collect_descriptions([posting], {}, client, state={}, now=NOW)
    assert count == 0 and rows[0].description_status == "unavailable"


def test_workable_listing_is_not_certified_complete() -> None:
    from poller.description_pipeline import attach_source_context
    from poller.models import RawPosting, SourceConfig

    posting = make_posting("1", ats="workable", url="https://apply.workable.com/acme/j/ABC/",
                           description="Listing teaser")
    raw = RawPosting(source="workable", company_slug="acme", source_job_id="ABC",
                     title=posting.title, location=posting.location, url=posting.url,
                     posted_at=None, description="Listing teaser", raw_data={}, locations=[])
    result = attach_source_context(posting, raw, SourceConfig(type="workable", board_token="acme"))
    assert result.description_status != "available"


@pytest.mark.asyncio
async def test_registry_correction_invalidates_backoff() -> None:
    posting = make_posting("1", ats="other", url="https://example.com/jobs?gh_jid=123")
    state: dict[str, dict[str, Any]] = {}
    await collect_descriptions([posting], {}, FakeClient({}), state=state, now=NOW,
                               greenhouse_boards={"example": "old-board"})
    client = FakeClient({API: {"content": "Correct job description."}})
    rows, count = await collect_descriptions([posting], {}, client, state=state, now=NOW,
                                            greenhouse_boards={"example": "acme"})
    assert count == 1 and rows[0].description_text == "Correct job description."


def test_ambiguous_registry_boards_are_not_guessed() -> None:
    from poller.description_pipeline import greenhouse_board_map
    from poller.models import SourceConfig
    from poller.tests.conftest import make_company

    company = make_company()
    assert greenhouse_board_map([company]) == {"acme": "acme"}
    company.sources.append(SourceConfig(type="greenhouse", board_token="other-board"))
    assert greenhouse_board_map([company]) == {}


@pytest.mark.asyncio
async def test_expired_description_waiting_for_budget_is_stale() -> None:
    state: dict[str, dict[str, Any]] = {}
    posting = make_posting("1", ats="greenhouse", url=URL)
    rows, _ = await collect_descriptions([posting], {}, FakeClient({API: {"content": "Full text"}}),
                                        state=state, now=NOW)
    rows, count = await collect_descriptions(rows, {}, FakeClient({}), state=state,
                                           now="2026-09-10T12:00:00Z", limit=0)
    assert count == 0 and rows[0].description_text == "Full text"
    assert rows[0].description_status == "stale"


@pytest.mark.asyncio
async def test_due_refresh_gets_capacity_alongside_never_attempted_jobs() -> None:
    state: dict[str, dict[str, Any]] = {}
    old = make_posting("old", ats="greenhouse", url=URL)
    rows, _ = await collect_descriptions([old], {}, FakeClient({API: {"content": "Full text"}}),
                                        state=state, now=NOW)
    new = [make_posting(f"new{i}", ats="greenhouse", url=URL) for i in range(8)]
    await collect_descriptions(new + rows, {}, FakeClient({API: {"content": "Full text"}}),
                               state=state, now="2026-09-10T12:00:00Z", limit=4)
    assert state["old"]["last_success_at"] == "2026-09-10T12:00:00Z"


@pytest.mark.asyncio
async def test_supported_api_failure_can_fall_back_to_its_verified_public_page() -> None:
    from poller.tests.test_first_party_details import PageClient

    class FallbackClient(PageClient):
        async def get_json(self, *args: Any, **kwargs: Any) -> Any:
            raise ValueError("api_unavailable")

    rows, count = await collect_descriptions([make_posting("1", ats="greenhouse", url=URL)],
                                            {}, FallbackClient(), state={}, now=NOW)
    assert count == 1 and rows[0].description_status == "available"


def test_regional_greenhouse_url_retains_job_identity() -> None:
    posting = make_posting("1", ats="other", url="https://job-boards.eu.greenhouse.io/acme/jobs/123")
    result = resolve_detail_posting(posting)
    assert result is not None and result.ats == "greenhouse"
