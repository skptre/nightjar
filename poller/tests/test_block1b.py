from __future__ import annotations

import pytest

from poller.dedupe import SOURCE_PRIORITY
from poller.models import compute_posting_id
from poller.registry import VALID_SOURCE_TYPES
from poller.sources import ADAPTERS
from poller.sources.bamboohr import BambooHRAdapter
from poller.sources.breezy import BreezyAdapter
from poller.sources.comeet import ComeetAdapter
from poller.sources.jazzhr import JazzHRAdapter
from poller.sources.pinpoint import PinpointAdapter
from poller.sources.recruitee import RecruiteeAdapter
from poller.sources.teamtailor import TeamtailorAdapter
from poller.sources.workable import WorkableAdapter
from poller.tests.conftest import (
    MockTransport,
    json_response,
    load_fixture,
    make_company,
    make_mock_client,
)

# ---------------------------------------------------------------------------
# Registration tests
# ---------------------------------------------------------------------------

BLOCK_1B_SOURCES = [
    "recruitee", "bamboohr", "workable", "breezy",
    "jazzhr", "teamtailor", "pinpoint", "comeet",
]


@pytest.mark.parametrize("source_type", BLOCK_1B_SOURCES)
def test_source_in_valid_types(source_type: str) -> None:
    assert source_type in VALID_SOURCE_TYPES


@pytest.mark.parametrize("source_type", BLOCK_1B_SOURCES)
def test_source_in_adapters(source_type: str) -> None:
    assert source_type in ADAPTERS


@pytest.mark.parametrize("source_type", BLOCK_1B_SOURCES)
def test_source_in_priority(source_type: str) -> None:
    assert source_type in SOURCE_PRIORITY


@pytest.mark.parametrize("source_type", BLOCK_1B_SOURCES)
def test_adapter_instantiation(source_type: str) -> None:
    adapter = ADAPTERS[source_type]()
    assert adapter is not None


@pytest.mark.parametrize("source_type", BLOCK_1B_SOURCES)
def test_priority_is_3(source_type: str) -> None:
    assert SOURCE_PRIORITY[source_type] == 3


# ---------------------------------------------------------------------------
# Recruitee adapter tests
# ---------------------------------------------------------------------------

class TestRecruiteeAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("recruitee", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="recruitee", board_token="acme",
        )
        adapter = RecruiteeAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 3
        assert postings[0].title == "Software Engineering Intern - Summer 2027"
        assert postings[0].source == "recruitee"
        assert postings[0].source_job_id == "100001"
        assert postings[0].employment_type == "intern"
        assert postings[0].department == "Engineering"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("recruitee", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="recruitee", board_token="acme",
        )
        adapter = RecruiteeAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_multi_location(self) -> None:
        fixture = load_fixture("recruitee", "multi_location")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="recruitee", board_token="acme",
        )
        adapter = RecruiteeAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert len(postings[0].locations) == 3
        assert "Detroit, US" in postings[0].locations
        assert "Chicago, US" in postings[0].locations
        assert "Austin, US" in postings[0].locations

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("recruitee", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="recruitee", board_token="acme",
        )
        adapter = RecruiteeAdapter()
        raw_postings = await adapter.fetch(client, company, company.sources[0])
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw_postings[0], company, now)
        expected_id = compute_posting_id("recruitee", "acme", "100001")
        assert posting.id == expected_id
        assert posting.company == "Acme Corp"
        assert posting.source == "recruitee"
        assert posting.ats == "recruitee"
        assert posting.first_seen_at == now
        assert posting.employment_type == "intern"

    @pytest.mark.asyncio
    async def test_careers_url_fallback(self) -> None:
        fixture = {
            "offers": [{
                "id": 999,
                "title": "Test Role",
                "slug": "test-role",
            }],
        }
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="recruitee", board_token="testco",
        )
        adapter = RecruiteeAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[0].url == "https://testco.recruitee.com/o/test-role"

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = {"offers": [{"bad": "data"}, {"id": 1, "title": "Good"}]}
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="recruitee", board_token="acme",
        )
        adapter = RecruiteeAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1

    @pytest.mark.asyncio
    async def test_html_description_cleaned(self) -> None:
        fixture = load_fixture("recruitee", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="recruitee", board_token="acme",
        )
        adapter = RecruiteeAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        assert "<p>" not in posting.description_text
        assert "Join our engineering team" in posting.description_text


# ---------------------------------------------------------------------------
# BambooHR adapter tests
# ---------------------------------------------------------------------------

class TestBambooHRAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("bamboohr", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="bamboohr", board_token="acme",
        )
        adapter = BambooHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Software Engineering Intern"
        assert postings[0].source == "bamboohr"
        assert postings[0].location == "Seattle, WA"
        assert postings[0].employment_type == "Intern"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("bamboohr", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="bamboohr", board_token="acme",
        )
        adapter = BambooHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_string_department(self) -> None:
        fixture = load_fixture("bamboohr", "string_department")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="bamboohr", board_token="acme",
        )
        adapter = BambooHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert postings[0].department == "Operations"

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("bamboohr", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="bamboohr", board_token="acme",
        )
        adapter = BambooHRAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("bamboohr", "acme", "50001")
        assert posting.id == expected_id
        assert posting.url == "https://acme.bamboohr.com/careers/50001"
        assert posting.ats == "bamboohr"

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = {"result": [{"bad": "data"}]}
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="bamboohr", board_token="acme",
        )
        adapter = BambooHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []


# ---------------------------------------------------------------------------
# Workable adapter tests
# ---------------------------------------------------------------------------

class TestWorkableAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("workable", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="workable", board_token="acme",
        )
        adapter = WorkableAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Backend Engineering Intern"
        assert postings[0].source_job_id == "WK0001"
        assert postings[0].location == "San Francisco, CA"
        assert postings[0].employment_type == "Internship"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("workable", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="workable", board_token="acme",
        )
        adapter = WorkableAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_remote_detection(self) -> None:
        fixture = load_fixture("workable", "remote_jobs")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="workable", board_token="acme",
        )
        adapter = WorkableAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert postings[0].workplace_type == "remote"

    @pytest.mark.asyncio
    async def test_remote_via_flag(self) -> None:
        fixture = load_fixture("workable", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="workable", board_token="acme",
        )
        adapter = WorkableAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[1].workplace_type == "remote"
        assert postings[0].workplace_type is None

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("workable", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="workable", board_token="acme",
        )
        adapter = WorkableAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("workable", "acme", "WK0001")
        assert posting.id == expected_id
        assert posting.url == "https://apply.workable.com/acme/j/WK0001/"
        assert posting.ats == "workable"
        assert posting.workplace_type is None

    @pytest.mark.asyncio
    async def test_normalize_remote(self) -> None:
        fixture = load_fixture("workable", "remote_jobs")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="workable", board_token="acme",
        )
        adapter = WorkableAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        assert posting.workplace_type == "remote"


# ---------------------------------------------------------------------------
# Breezy adapter tests
# ---------------------------------------------------------------------------

class TestBreezyAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("breezy", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="breezy", board_token="acme",
        )
        adapter = BreezyAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Frontend Engineering Intern"
        assert postings[0].source == "breezy"
        assert postings[0].location == "Austin, TX"
        assert postings[0].employment_type == "Internship"
        assert postings[0].department == "Engineering"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("breezy", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="breezy", board_token="acme",
        )
        adapter = BreezyAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_string_location_and_type(self) -> None:
        fixture = load_fixture("breezy", "string_type")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="breezy", board_token="acme",
        )
        adapter = BreezyAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert postings[0].location == "Portland"
        assert postings[0].employment_type == "Full-time"

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("breezy", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="breezy", board_token="acme",
        )
        adapter = BreezyAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("breezy", "acme", "pos_abc123")
        assert posting.id == expected_id
        assert posting.url == "https://acme.breezy.hr/p/frontend-engineering-intern"
        assert posting.ats == "breezy"
        assert "<p>" not in posting.description_text

    @pytest.mark.asyncio
    async def test_verbose_param_sent(self) -> None:
        fixture = load_fixture("breezy", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="breezy", board_token="acme",
        )
        adapter = BreezyAdapter()
        await adapter.fetch(client, company, company.sources[0])
        request = transport.requests[0]
        assert b"verbose=true" in request.url.raw_path

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = [{"bad": "data"}, {"id": "x", "name": "OK"}]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="breezy", board_token="acme",
        )
        adapter = BreezyAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1


# ---------------------------------------------------------------------------
# Posting ID stability
# ---------------------------------------------------------------------------

class TestPostingIdStability:

    def test_recruitee_id_deterministic(self) -> None:
        id1 = compute_posting_id("recruitee", "acme", "100001")
        id2 = compute_posting_id("recruitee", "acme", "100001")
        assert id1 == id2

    def test_bamboohr_id_deterministic(self) -> None:
        id1 = compute_posting_id("bamboohr", "acme", "50001")
        id2 = compute_posting_id("bamboohr", "acme", "50001")
        assert id1 == id2

    def test_workable_id_deterministic(self) -> None:
        id1 = compute_posting_id("workable", "acme", "WK0001")
        id2 = compute_posting_id("workable", "acme", "WK0001")
        assert id1 == id2

    def test_breezy_id_deterministic(self) -> None:
        id1 = compute_posting_id("breezy", "acme", "pos_abc123")
        id2 = compute_posting_id("breezy", "acme", "pos_abc123")
        assert id1 == id2

    def test_jazzhr_id_deterministic(self) -> None:
        id1 = compute_posting_id("jazzhr", "acme", "JZ001")
        id2 = compute_posting_id("jazzhr", "acme", "JZ001")
        assert id1 == id2

    def test_teamtailor_id_deterministic(self) -> None:
        id1 = compute_posting_id("teamtailor", "acme", "TT001")
        id2 = compute_posting_id("teamtailor", "acme", "TT001")
        assert id1 == id2

    def test_pinpoint_id_deterministic(self) -> None:
        id1 = compute_posting_id("pinpoint", "acme", "5001")
        id2 = compute_posting_id("pinpoint", "acme", "5001")
        assert id1 == id2

    def test_comeet_id_deterministic(self) -> None:
        id1 = compute_posting_id("comeet", "acme", "CM001")
        id2 = compute_posting_id("comeet", "acme", "CM001")
        assert id1 == id2

    def test_different_sources_different_ids(self) -> None:
        ids = {
            compute_posting_id(src, "acme", "123")
            for src in BLOCK_1B_SOURCES
        }
        assert len(ids) == 8


# ---------------------------------------------------------------------------
# JazzHR adapter tests
# ---------------------------------------------------------------------------

class TestJazzHRAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("jazzhr", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="jazzhr", board_token="acme",
        )
        adapter = JazzHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Software Engineering Intern - Summer 2027"
        assert postings[0].source == "jazzhr"
        assert postings[0].source_job_id == "JZ001"
        assert postings[0].employment_type == "Internship"
        assert postings[0].department == "Engineering"
        assert postings[0].location == "Boston, MA"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("jazzhr", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="jazzhr", board_token="acme",
        )
        adapter = JazzHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_no_location(self) -> None:
        fixture = load_fixture("jazzhr", "no_location")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="jazzhr", board_token="acme",
        )
        adapter = JazzHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert postings[0].location == ""
        assert postings[0].locations == []

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("jazzhr", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="jazzhr", board_token="acme",
        )
        adapter = JazzHRAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("jazzhr", "acme", "JZ001")
        assert posting.id == expected_id
        assert posting.company == "Acme Corp"
        assert posting.source == "jazzhr"
        assert posting.ats == "jazzhr"
        assert posting.first_seen_at == now
        assert posting.employment_type == "Internship"

    @pytest.mark.asyncio
    async def test_html_description_cleaned(self) -> None:
        fixture = load_fixture("jazzhr", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="jazzhr", board_token="acme",
        )
        adapter = JazzHRAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        assert "<p>" not in posting.description_text
        assert "Join our engineering team" in posting.description_text

    @pytest.mark.asyncio
    async def test_apikey_param_sent(self) -> None:
        fixture = load_fixture("jazzhr", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="jazzhr", board_token="testkey",
        )
        adapter = JazzHRAdapter()
        await adapter.fetch(client, company, company.sources[0])
        request = transport.requests[0]
        assert b"apikey=testkey" in request.url.raw_path

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = [{"bad": "data"}, {"id": "x", "title": "OK"}]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="jazzhr", board_token="acme",
        )
        adapter = JazzHRAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1


# ---------------------------------------------------------------------------
# Teamtailor adapter tests
# ---------------------------------------------------------------------------

class TestTeamtailorAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("teamtailor", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Software Engineering Intern"
        assert postings[0].source == "teamtailor"
        assert postings[0].source_job_id == "TT001"
        assert postings[0].employment_type == "Internship"
        assert postings[0].department == "Engineering"
        assert postings[0].location == "Stockholm, Sweden"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("teamtailor", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_multi_location(self) -> None:
        fixture = load_fixture("teamtailor", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings[1].locations) == 2
        assert "San Francisco, CA" in postings[1].locations
        assert "Remote" in postings[1].locations

    @pytest.mark.asyncio
    async def test_hybrid_workplace(self) -> None:
        fixture = load_fixture("teamtailor", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[0].workplace_type is None
        assert postings[1].workplace_type == "hybrid"

    @pytest.mark.asyncio
    async def test_no_included_graceful(self) -> None:
        fixture = load_fixture("teamtailor", "no_included")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert postings[0].department is None
        assert postings[0].locations == []
        assert postings[0].workplace_type == "remote"

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("teamtailor", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("teamtailor", "acme", "TT001")
        assert posting.id == expected_id
        assert posting.url == "https://career.acme.com/jobs/tt001-software-engineering-intern"
        assert posting.ats == "teamtailor"
        assert "<p>" not in posting.description_text

    @pytest.mark.asyncio
    async def test_url_fallback(self) -> None:
        fixture = {
            "data": [{
                "id": "999",
                "type": "jobs",
                "links": {},
                "attributes": {"title": "Test", "body": ""},
                "relationships": {},
            }],
            "meta": {"record-count": 1},
        }
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="testco",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[0].url == "https://testco.teamtailor.com/jobs/999"

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = {
            "data": [{"bad": "data"}, {"id": "1", "attributes": {"title": "OK"}}],
            "meta": {},
        }
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="teamtailor", board_token="acme",
        )
        adapter = TeamtailorAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1


# ---------------------------------------------------------------------------
# Pinpoint adapter tests
# ---------------------------------------------------------------------------

class TestPinpointAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("pinpoint", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Software Engineering Intern"
        assert postings[0].source == "pinpoint"
        assert postings[0].source_job_id == "5001"
        assert postings[0].employment_type == "Internship"
        assert postings[0].department == "Engineering"
        assert postings[0].location == "London, UK"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("pinpoint", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_remote_detection(self) -> None:
        fixture = load_fixture("pinpoint", "remote_jobs")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert postings[0].workplace_type == "remote"

    @pytest.mark.asyncio
    async def test_hybrid_detection(self) -> None:
        fixture = load_fixture("pinpoint", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[0].workplace_type is None
        assert postings[1].workplace_type == "hybrid"

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("pinpoint", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("pinpoint", "acme", "5001")
        assert posting.id == expected_id
        assert posting.url == "https://acme.pinpointhq.com/en/postings/5001"
        assert posting.ats == "pinpoint"
        assert "<p>" not in posting.description_text

    @pytest.mark.asyncio
    async def test_normalize_remote(self) -> None:
        fixture = load_fixture("pinpoint", "remote_jobs")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        assert posting.workplace_type == "remote"

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = {"data": [{"bad": "data"}, {"id": 1, "attributes": {"title": "OK"}}]}
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="pinpoint", board_token="acme",
        )
        adapter = PinpointAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1


# ---------------------------------------------------------------------------
# Comeet adapter tests
# ---------------------------------------------------------------------------

class TestComeetAdapter:

    @pytest.mark.asyncio
    async def test_fetch_normal_board(self) -> None:
        fixture = load_fixture("comeet", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="comeet", board_token="acme",
        )
        adapter = ComeetAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 2
        assert postings[0].title == "Software Engineering Intern"
        assert postings[0].source == "comeet"
        assert postings[0].source_job_id == "CM001"
        assert postings[0].employment_type == "Internship"
        assert postings[0].department == "R&D"
        assert postings[0].location == "Tel Aviv, Israel"

    @pytest.mark.asyncio
    async def test_fetch_empty_board(self) -> None:
        fixture = load_fixture("comeet", "empty_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="comeet", board_token="acme",
        )
        adapter = ComeetAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings == []

    @pytest.mark.asyncio
    async def test_multi_location(self) -> None:
        fixture = load_fixture("comeet", "multi_location")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="comeet", board_token="acme",
        )
        adapter = ComeetAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
        assert len(postings[0].locations) == 2
        assert "San Francisco, CA" in postings[0].locations
        assert "Austin, TX" in postings[0].locations

    @pytest.mark.asyncio
    async def test_location_with_state(self) -> None:
        fixture = load_fixture("comeet", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="comeet", board_token="acme",
        )
        adapter = ComeetAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[1].location == "New York, NY"

    @pytest.mark.asyncio
    async def test_normalize(self) -> None:
        fixture = load_fixture("comeet", "normal_board")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", name="Acme Corp",
            source_type="comeet", board_token="acme",
        )
        adapter = ComeetAdapter()
        raw = (await adapter.fetch(client, company, company.sources[0]))[0]
        now = "2026-09-01T12:00:00Z"
        posting = adapter.normalize(raw, company, now)
        expected_id = compute_posting_id("comeet", "acme", "CM001")
        assert posting.id == expected_id
        assert posting.url == "https://www.comeet.com/jobs/acme/A1/software-engineering-intern/CM001"
        assert posting.ats == "comeet"
        assert "<p>" not in posting.description_text

    @pytest.mark.asyncio
    async def test_url_fallback(self) -> None:
        fixture = [{"uid": "X99", "name": "Test"}]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="comeet", board_token="uid123",
        )
        adapter = ComeetAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert postings[0].url == "https://www.comeet.com/jobs/uid123/X99"

    @pytest.mark.asyncio
    async def test_malformed_posting_skipped(self) -> None:
        fixture = [{"bad": "data"}, {"uid": "x", "name": "OK"}]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        company = make_company(
            slug="acme", source_type="comeet", board_token="acme",
        )
        adapter = ComeetAdapter()
        postings = await adapter.fetch(client, company, company.sources[0])
        assert len(postings) == 1
