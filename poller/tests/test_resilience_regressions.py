from __future__ import annotations

import hashlib
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from unittest.mock import AsyncMock

import pytest

from poller.dedupe import canonicalize_url, dedupe_postings
from poller.description_packs import read_description_pack, write_description_packs
from poller.diff import compute_diff
from poller.exceptions import SourceFetchError, SourceParseError
from poller.filter import filter_student_roles
from poller.models import SourceHealth
from poller.sources import get_adapter
from poller.sources.public_careers import PublicCareersAdapter
from poller.sources.usajobs import USAJobsAdapter
from poller.sources.workday import WorkdayAdapter
from poller.store import RunState, save_feed_sharded, save_state
from poller.tests.conftest import make_company, make_posting

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.asyncio
async def test_reviewed_complete_drop_can_recover_without_disabling_schema_safety() -> None:
    from unittest.mock import patch

    from poller.main import _poll_source
    from poller.models import RawPosting

    company = make_company()
    raw = RawPosting(
        source="greenhouse",
        company_slug="acme",
        source_job_id="1",
        title="Intern",
        location="New York, NY",
        locations=["New York, NY"],
        url="https://example.com/1",
        posted_at=None,
        description="",
    )
    adapter = AsyncMock()
    adapter.fetch.return_value = [raw]
    adapter.normalize = lambda *args: make_posting()
    adapter.potentially_truncated = False
    with patch("poller.main.get_adapter", return_value=adapter):
        _, _, health, _ = await _poll_source(
            AsyncMock(),
            company,
            company.sources[0],
            "2026-10-24T00:00:00Z",
            SourceHealth(last_complete_count=100),
            approve_drop=True,
        )
    assert health.healthy and health.last_complete_count == 1


def test_public_state_redacts_legacy_header_credentials(tmp_path: Path) -> None:
    state = RunState(
        sources={
            "usajobs:nasa": SourceHealth(
                error=(
                    "Illegal header value b'USAJOBS_API_KEY = sentinel-secret\\n"
                    "USAJOBS_EMAIL = test@example.com'"
                ),
            )
        }
    )
    save_state(tmp_path / "state.json", state)
    assert "sentinel-secret" not in (tmp_path / "state.json").read_text()


def test_old_success_is_not_reported_as_current_source_health() -> None:
    from poller.tools.health import build_health_report

    state = RunState(
        last_run_at="2026-10-24T00:00:00Z",
        sources={
            "greenhouse:acme": SourceHealth(healthy=True, last_polled_at="2026-09-01T00:00:00Z")
        },
    )
    report = build_health_report(state, datetime(2026, 10, 24, tzinfo=UTC))
    assert not report["healthy"]
    assert not report["sources"]["greenhouse:acme"]["healthy"]


@pytest.mark.asyncio
async def test_invalid_secret_fails_before_any_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USAJOBS_API_KEY", "USAJOBS_API_KEY = sentinel-secret\n")
    monkeypatch.setenv("USAJOBS_EMAIL", "test@example.com")
    client = AsyncMock()
    company = make_company(source_type="usajobs", board_token="NN")
    with pytest.raises(SourceFetchError, match="configuration"):
        await USAJobsAdapter().fetch(client, company, company.sources[0])
    client.get_json.assert_not_called()


def test_query_job_ids_are_not_tracking_parameters() -> None:
    a = replace(
        make_posting(pid="a", title="Mechanical Intern"),
        url="https://example.com/position?gh_jid=111",
    )
    b = replace(
        make_posting(pid="b", title="Finance Intern", source_job_id="222"),
        url="https://example.com/position?gh_jid=222",
    )
    assert len(dedupe_postings([a, b])) == 2
    assert canonicalize_url(a.url, provider="greenhouse", has_source_job_id=True) != (
        canonicalize_url(b.url, provider="greenhouse", has_source_job_id=True)
    )


def test_merges_preserve_all_transitive_aliases_without_self_ids() -> None:
    a = replace(make_posting(pid="a"), merged_from=["older"])
    b = replace(a, id="b", source="simplify", merged_from=["oldest"])
    row = dedupe_postings([a, b, a])[0]
    assert set(row.merged_from) == {"older", "b", "oldest"}
    assert len(row.merged_from) == 3


def test_changing_canonical_source_keeps_the_existing_tracker_identity() -> None:
    previous = make_posting(pid="saved-id", source="simplify")
    current = replace(previous, id="direct-id", source="greenhouse", merged_from=["saved-id"])
    state = RunState(active_ids={"saved-id"})
    feed, _, diff = compute_diff(
        [current],
        {previous.id: previous},
        state,
        "2026-10-24T00:00:00Z",
        observed_ids={"direct-id"},
    )
    assert "saved-id" in feed and "direct-id" not in feed
    assert feed["saved-id"].source == "greenhouse"
    assert not diff.new_ids


def test_student_filter_recognizes_program_evidence_and_excludes_program_staff() -> None:
    rows = [
        make_posting(pid="a", title="Undergraduate Research Assistant"),
        make_posting(pid="b", title="Student Worker Automation Engineer"),
        replace(make_posting(pid="c", title="Software Engineer"), employment_type="Internship"),
        make_posting(pid="d", title="Internship Program Manager"),
    ]
    assert {p.id for p in filter_student_roles(rows)} == {"a", "b", "c"}


def test_publication_timestamp_does_not_invalidate_unchanged_shards(tmp_path: Path) -> None:
    rows = {"a": make_posting()}
    first = save_feed_sharded(tmp_path, rows, "2026-10-01T00:00:00Z")
    second = save_feed_sharded(tmp_path, rows, "2026-10-02T00:00:00Z")
    assert second["greenhouse"].sha256 == first["greenhouse"].sha256


def test_shard_references_are_immutable_across_publications(tmp_path: Path) -> None:
    row = make_posting()
    first = save_feed_sharded(tmp_path, {row.id: row}, "2026-10-01T00:00:00Z")
    path = getattr(first["greenhouse"], "path", None)
    assert path is not None
    content = (tmp_path / path).read_bytes()
    save_feed_sharded(
        tmp_path, {row.id: replace(row, title="Finance Intern")}, "2026-10-02T00:00:00Z"
    )
    assert (tmp_path / path).read_bytes() == content


def test_old_manifest_can_still_read_its_immutable_description_pack(tmp_path: Path) -> None:
    one = "Description one"
    prefix = hashlib.sha256(one.encode()).hexdigest()[0]
    two = next(
        f"Description {i}"
        for i in range(1000)
        if hashlib.sha256(f"Description {i}".encode()).hexdigest()[0] == prefix
    )
    posting = replace(make_posting(), description_text=one)
    first = write_description_packs(tmp_path, {posting.id: posting})[posting.id]
    write_description_packs(tmp_path, {posting.id: replace(posting, description_text=two)})
    assert read_description_pack(tmp_path, first) == one


def test_retirement_grace_starts_when_an_old_document_is_replaced(tmp_path: Path) -> None:
    from poller.description_packs import prune_description_packs

    posting = replace(make_posting(), description_text="Original document")
    first = write_description_packs(tmp_path, {posting.id: posting})
    now = datetime(2026, 10, 1, tzinfo=UTC)
    prune_description_packs(tmp_path, first, now=now)
    second = write_description_packs(
        tmp_path, {posting.id: replace(posting, description_text="New document")}
    )
    prune_description_packs(tmp_path, second, now=now + timedelta(days=10))
    assert read_description_pack(tmp_path, first[posting.id]) == "Original document"
    prune_description_packs(tmp_path, second, now=now + timedelta(days=14))
    assert not (tmp_path / first[posting.id]["pack"]).exists()


@pytest.mark.asyncio
async def test_workday_supports_geography_facets_with_board_specific_names() -> None:
    company = make_company(source_type="workday", board_token="acme.wd5.myworkdayjobs.com/Jobs")
    adapter = WorkdayAdapter()
    partition_mock = AsyncMock(
        return_value=[
            adapter._parse_job(
                {
                    "title": "Intern",
                    "externalPath": f"/job/US-CA/X_{i}",
                    "locationsText": "California, USA",
                },
                company,
                "acme",
                "Jobs",
            )
            for i in range(2)
        ]
    )
    adapter.__dict__["_fetch_partition"] = partition_mock
    data = {
        "total": 2,
        "jobPostings": [],
        "facets": [
            {
                "facetParameter": "Location_Country",
                "values": [{"id": "US", "count": 1}, {"id": "CA", "count": 1}],
            }
        ],
    }
    rows = await adapter._split_capped_search(AsyncMock(), company, "acme", "Jobs", "url", {}, data)
    assert len(rows) == 2
    assert partition_mock.await_count == 2


@pytest.mark.asyncio
async def test_workday_resolves_us_country_before_discarding_multi_location_students() -> None:
    company = make_company(source_type="workday", board_token="acme.wd5.myworkdayjobs.com/Jobs")
    client = AsyncMock()
    client.post_json.return_value = {
        "total": 1,
        "jobPostings": [
            {
                "title": "Physics Intern",
                "externalPath": "/job/Lemont/Physics_JR1",
                "locationsText": "2 Locations",
                "bulletFields": [],
            }
        ],
    }
    client.get_json.return_value = {
        "jobPostingInfo": {
            "location": "Lemont, IL USA",
            "additionalLocations": ["New York, NY"],
            "country": {"descriptor": "United States of America"},
        }
    }
    rows = await WorkdayAdapter().fetch(client, company, company.sources[0])
    assert "Lemont" in rows[0].location
    assert "2 Locations" not in rows[0].locations
    assert len(rows[0].locations) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "info,partial",
    [
        ({"location": "Lemont", "additionalLocations": ["Batavia"]}, True),
        ({"location": "2 Locations", "country": {"descriptor": "United States of America"}}, False),
    ],
)
async def test_workday_unresolved_details_cannot_confirm_absence(
    info: dict[str, object], partial: bool
) -> None:
    company = make_company(source_type="workday", board_token="acme.wd5.myworkdayjobs.com/Jobs")
    client = AsyncMock()
    client.post_json.return_value = {
        "total": 1,
        "jobPostings": [
            {
                "title": "Physics Intern",
                "externalPath": "/job/Lemont/Physics_JR1",
                "locationsText": "2 Locations",
            }
        ],
    }
    client.get_json.return_value = {"jobPostingInfo": info}
    adapter = WorkdayAdapter()
    assert len(await adapter.fetch(client, company, company.sources[0])) == 1
    assert adapter.potentially_truncated is partial


@pytest.mark.asyncio
async def test_workday_missing_initial_total_is_not_a_complete_empty_board() -> None:
    client = AsyncMock()
    client.post_json.return_value = {"jobPostings": []}
    company = make_company(source_type="workday", board_token="acme.wd5.myworkdayjobs.com/Jobs")
    with pytest.raises(SourceParseError, match="total"):
        await WorkdayAdapter().fetch(client, company, company.sources[0])


@pytest.mark.asyncio
async def test_eightfold_public_board_collects_distinct_pages_and_normalizes_identity() -> None:
    company = make_company(
        slug="netflix",
        name="Netflix",
        source_type="eightfold",
        board_token="explore.jobs.netflix.net/netflix.com",
    )
    client = AsyncMock()
    positions = [
        {
            "id": str(i),
            "name": "Engineering Intern",
            "locations": ["Los Gatos, CA, USA"],
            "canonicalPositionUrl": f"https://explore.jobs.netflix.net/careers/job/{i}",
        }
        for i in range(12)
    ]
    client.get_json.side_effect = [
        {"positions": positions[:10], "count": 12},
        {"positions": positions[10:], "count": 12},
    ]
    adapter = get_adapter("eightfold")
    rows = await adapter.fetch(client, company, company.sources[0])
    assert len(rows) == 12
    posting = adapter.normalize(rows[0], company, "2026-10-24T00:00:00Z")
    assert posting.company == "Netflix" and posting.source_job_id == "0"
    assert not adapter.potentially_truncated


@pytest.mark.asyncio
async def test_public_google_and_apple_hydration_is_read_without_running_scripts() -> None:
    import json

    google = [
        "id1",
        "Student Researcher",
        "",
        [None, "<p>Responsibilities</p>"],
        [None, "Qualifications"],
        None,
        None,
        "Google",
        "en",
        [["New York, NY, USA"]],
        [None, "About"],
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        [None, "Education"],
    ]
    apple = {
        "loaderData": {
            "search": {
                "searchResults": [
                    {
                        "id": "2001",
                        "positionId": "2001",
                        "postingTitle": "Engineering Intern",
                        "locations": [
                            {
                                "city": "Cupertino",
                                "stateProvince": "CA",
                                "countryName": "United States",
                            }
                        ],
                        "jobSummary": "Build products",
                    }
                ],
                "totalRecords": 1,
            }
        }
    }
    cases = [
        (
            "https://www.google.com/about/careers/applications/jobs/results/",
            "AF_initDataCallback({key: 'ds:1',data:" + json.dumps([[google], None, 1, 20]) + "});",
        ),
        (
            "https://jobs.apple.com/en-us/search?team=internships-STDNT-INTRN",
            "window.__staticRouterHydrationData = JSON.parse("
            + json.dumps(json.dumps(apple))
            + ");",
        ),
    ]
    for url, body in cases:
        company = make_company(source_type="public_careers", board_token=url)
        client = AsyncMock()
        client.get_text.return_value = body
        rows = await get_adapter("public_careers").fetch(client, company, company.sources[0])
        assert len(rows) == 1
        assert rows[0].title in {"Student Researcher", "Engineering Intern"}


@pytest.mark.asyncio
async def test_public_amazon_uses_explicit_internship_evidence() -> None:
    company = make_company(
        source_type="public_careers",
        board_token="https://www.amazon.jobs/en/search.json?base_query=Intern",
    )
    client = AsyncMock()
    client.get_json.return_value = {
        "hits": 1,
        "jobs": [
            {
                "id": "abc",
                "id_icims": "123",
                "title": "Engineering Placement",
                "job_path": "/en/jobs/123/engineering",
                "location": "US, WA, Seattle",
                "is_intern": True,
                "description": "Build",
                "basic_qualifications": "Student",
            }
        ],
    }
    rows = await get_adapter("public_careers").fetch(client, company, company.sources[0])
    assert len(rows) == 1 and rows[0].employment_type == "Internship"


@pytest.mark.asyncio
async def test_oracle_offset_is_inside_finder_and_inner_total_controls_completion() -> None:
    company = make_company(
        source_type="oracle_careers", board_token="enterpriseplatform.dell.com/CX_1001/careers"
    )
    client = AsyncMock()
    client.get_json.side_effect = [
        {
            "count": 1,
            "hasMore": False,
            "items": [
                {
                    "TotalJobsCount": 2,
                    "requisitionList": [
                        {
                            "Id": str(i),
                            "Title": "Engineering Intern",
                            "PrimaryLocation": "Austin, TX",
                            "PrimaryLocationCountry": "US",
                        }
                    ],
                }
            ],
        }
        for i in range(2)
    ]
    adapter = get_adapter("oracle_careers")
    rows = await adapter.fetch(client, company, company.sources[0])
    assert len(rows) == 2 and not adapter.potentially_truncated
    assert "offset=1" in client.get_json.call_args.kwargs["params"]["finder"]
    assert rows[0].location.endswith("USA")


@pytest.mark.asyncio
async def test_recruitpro_empty_board_requires_verified_zero_count() -> None:
    company = make_company(source_type="recruitpro", board_token="calstart.recruitpro.com/659")
    client = AsyncMock()
    adapter = get_adapter("recruitpro")
    client.get_json.return_value = {"success": True, "data": {"jobs": [], "jobCount": 0}}
    assert await adapter.fetch(client, company, company.sources[0]) == []
    assert not adapter.potentially_truncated
    client.get_json.return_value["data"]["jobCount"] = 10
    await adapter.fetch(client, company, company.sources[0])
    assert adapter.potentially_truncated


@pytest.mark.asyncio
async def test_apple_all_roles_are_not_assumed_to_be_internships() -> None:
    adapter = PublicCareersAdapter()
    raw = adapter._parse(
        {"positionId": "1", "postingTitle": "Engineering Manager", "locations": []},
        "jobs.apple.com",
        make_company(),
    )
    assert raw.employment_type is None


@pytest.mark.asyncio
async def test_eightfold_empty_error_envelope_is_success() -> None:
    company = make_company(
        source_type="eightfold", board_token="apply.careers.microsoft.com/microsoft.com"
    )
    client = AsyncMock()
    client.get_json.return_value = {
        "status": 200,
        "error": {"message": "", "body": ""},
        "data": {"positions": [], "count": 0},
    }
    adapter = get_adapter("eightfold")
    assert await adapter.fetch(client, company, company.sources[0]) == []
    assert not adapter.potentially_truncated


def test_apple_location_variants_have_distinct_listing_identity() -> None:
    adapter = PublicCareersAdapter()
    rows = [
        adapter._parse(
            {
                "positionId": "123",
                "id": f"123-{i}",
                "postingTitle": "Intern",
                "locations": [{"name": "Cupertino", "countryName": "United States"}],
            },
            "jobs.apple.com",
            make_company(),
        )
        for i in range(2)
    ]
    assert rows[0].source_job_id != rows[1].source_job_id
    assert "Cupertino" in rows[0].location


def test_publication_validator_rejects_broken_immutable_reference(tmp_path: Path) -> None:
    from poller.store import save_feed, save_meta
    from poller.tools.validate_publication import validate_publication

    posting = replace(make_posting(), description_text="Full description")
    postings = {posting.id: posting}
    save_feed(tmp_path / "feed.json", postings, "2026-10-24T00:00:00Z")
    shards = save_feed_sharded(tmp_path / "feed", postings, "2026-10-24T00:00:00Z")
    save_meta(
        tmp_path / "meta.json",
        tmp_path / "feed.json",
        "2026-10-24T00:00:00Z",
        1,
        shard_hashes=shards,
    )
    assert validate_publication(tmp_path)["postings"] == 1
    shard = next(iter(shards.values()))
    (tmp_path / "feed" / str(shard.path)).write_text("{}")
    with pytest.raises(ValueError, match="checksum"):
        validate_publication(tmp_path)


@pytest.mark.asyncio
async def test_discovery_feed_fallback_survives_common_crawl_outage(tmp_path: Path) -> None:
    import json
    from unittest.mock import patch

    from poller.store import save_feed
    from poller.tools.discover import run_discovery

    registry = tmp_path / "registry.yaml"
    registry.write_text(
        "- slug: known\n  name: Known\n  tags: [tech]\n"
        "  sources: [{type: lever, board_token: known}]\n"
    )
    save_feed(
        tmp_path / "feed.json",
        {"1": replace(make_posting(), url="https://jobs.lever.co/newcompany/123")},
        "2026-10-24T00:00:00Z",
    )
    with patch(
        "poller.tools.discover.discover_common_crawl",
        side_effect=SourceFetchError("discovery", "", "index unavailable"),
    ):
        result = await run_discovery(
            data_dir=tmp_path, registry_path=registry, client=AsyncMock(), verify=False
        )
    assert result.discovered == 1
    catalog = json.loads((tmp_path / "discovered_boards.json").read_text())
    assert catalog["candidates"][0]["board_token"] == "newcompany"
    assert "common_crawl_error" in catalog["metrics"]


def test_stable_identity_preserves_old_aliases_on_same_id_refresh() -> None:
    old = replace(make_posting(), id="a", merged_from=["b", "older"])
    current = replace(old, merged_from=[])
    feed, _, _ = compute_diff(
        [current], {"a": old}, RunState(active_ids={"a"}), "2026-10-24T00:00:00Z"
    )
    assert feed["a"].merged_from == ["b", "older"]


def test_fresh_alias_wins_over_carried_predecessor() -> None:
    old = replace(make_posting(), id="a", merged_from=["b"])
    fresh = replace(old, id="b", title="New Actual Role Title", merged_from=[])
    feed, _, _ = compute_diff(
        [old, fresh],
        {"a": old},
        RunState(active_ids={"a"}),
        "2026-10-24T00:00:00Z",
        observed_ids={"b"},
    )
    assert list(feed) == ["a"]
    assert feed["a"].title == fresh.title
    assert feed["a"].merged_from == ["b"]


@pytest.mark.asyncio
async def test_fresh_board_description_does_not_use_detail_request_budget() -> None:
    from poller.description_pipeline import DESCRIPTION_VERSION, collect_descriptions

    posting = replace(
        make_posting(),
        description_text="Fresh full board text",
        description_status="available",
        description_version=DESCRIPTION_VERSION,
    )
    state: dict[str, dict[str, Any]] = {}
    client = AsyncMock()
    await collect_descriptions([posting], {}, client, state=state, now="2026-10-01T00:00:00Z")
    rows, count = await collect_descriptions(
        [posting],
        {},
        client,
        state=state,
        now="2026-10-24T00:00:00Z",
        fresh_description_ids={posting.id},
    )
    assert count == 0 and rows[0].description_status == "available"
    client.get_json.assert_not_called()


def test_amazon_secondary_us_location_keeps_internship_and_canada_is_not_california() -> None:
    import json

    from poller.filter import is_us_location

    adapter = PublicCareersAdapter()
    job = {
        "id": "1",
        "title": "Intern",
        "job_path": "/en/jobs/1",
        "location": "CA, ON, Toronto",
        "country_code": "CAN",
        "city": "Toronto",
        "state": "Ontario",
    }
    canadian = adapter._parse(job, "www.amazon.jobs", make_company())
    assert not is_us_location(canadian.location, canadian.locations)
    job["locations"] = json.dumps([{"normalizedLocation": "Seattle, Washington, USA"}])
    multiple = adapter._parse(job, "www.amazon.jobs", make_company())
    assert is_us_location(multiple.location, multiple.locations)
    assert len(multiple.locations) == 2


def test_registry_candidates_preserve_discovery_and_surface_known_company_migrations(
    tmp_path: Path,
) -> None:
    import json

    from poller.sources.simplify import generate_registry_candidates

    path = tmp_path / "registry_candidates.json"
    path.write_text(
        json.dumps(
            [
                {
                    "slug": "discovered",
                    "inferred_ats": "ashby",
                    "inferred_board_token": "discovered",
                    "verified": True,
                }
            ]
        )
    )
    posting = replace(
        make_posting(),
        source="simplify",
        company_slug="known",
        url="https://jobs.lever.co/new-board/123",
    )
    generate_registry_candidates(
        [posting], {"known"}, path, known_source_keys={("lever", "old-board")}
    )
    candidates = json.loads(path.read_text())
    assert len(candidates) == 2
    assert any(c.get("verified") for c in candidates)
    assert any(c.get("inferred_board_token") == "new-board" for c in candidates)
