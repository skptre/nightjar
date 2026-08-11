from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import USER_AGENT, RateLimitedClient
from poller.models import Company, SourceConfig, compute_posting_id
from poller.sources.ashby import AshbyAdapter, _extract_locations, _format_compensation

FIXTURES = Path(__file__).parent / "fixtures" / "ashby"


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _make_company(slug: str = "testco", name: str = "TestCo") -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["fintech"],
        sources=[SourceConfig(type="ashby", board_token=slug)],
    )


class MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = list(responses)
        self._call_count = 0
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._call_count < len(self._responses):
            resp = self._responses[self._call_count]
        else:
            resp = self._responses[-1]
        self._call_count += 1
        resp.stream = httpx.ByteStream(resp.content)
        return resp


def _json_response(data: Any, status: int = 200) -> httpx.Response:
    body = json.dumps(data).encode()
    return httpx.Response(
        status_code=status,
        headers={"content-type": "application/json"},
        content=body,
    )


async def _make_client_with_transport(transport: MockTransport) -> RateLimitedClient:
    client = RateLimitedClient()
    client._client = httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(5.0),
        headers={"User-Agent": USER_AGENT},
    )
    return client


NOW = "2026-08-10T20:00:00Z"


# ── Fetch tests ─────────────────────────────────────────────────────


class TestAshbyFetch:
    @pytest.mark.asyncio
    async def test_compensation_board_returns_all_jobs(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert len(raw_postings) == 5
        await client.close()

    @pytest.mark.asyncio
    async def test_no_compensation_board_returns_all_jobs(self) -> None:
        fixture = _load_fixture("no_compensation_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company(slug="noco", name="NoCo")
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert len(raw_postings) == 3
        await client.close()

    @pytest.mark.asyncio
    async def test_include_compensation_param_in_request(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert b"includeCompensation=true" in request.url.raw_path
        await client.close()

    @pytest.mark.asyncio
    async def test_request_url_contains_board_token(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert "api.ashbyhq.com" in str(request.url)
        assert "/testco" in str(request.url)
        await client.close()

    @pytest.mark.asyncio
    async def test_empty_board_returns_empty_list(self) -> None:
        fixture = _load_fixture("empty_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert raw_postings == []
        await client.close()

    @pytest.mark.asyncio
    async def test_http_500_raises_source_fetch_error(self) -> None:
        transport = MockTransport([
            _json_response({"error": "server error"}, status=500),
            _json_response({"error": "server error"}, status=500),
            _json_response({"error": "server error"}, status=500),
        ])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        with pytest.raises(SourceFetchError):
            await adapter.fetch(client, company, source)
        await client.close()

    @pytest.mark.asyncio
    async def test_malformed_response_raises_parse_error(self) -> None:
        transport = MockTransport([_json_response({"not_jobs": []})])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        with pytest.raises(SourceParseError, match="expected object with 'jobs' key"):
            await adapter.fetch(client, company, source)
        await client.close()

    @pytest.mark.asyncio
    async def test_no_pagination_single_request(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = AshbyAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        assert len(transport.requests) == 1
        await client.close()


# ── Compensation formatting tests ───────────────────────────────────


class TestFormatCompensation:
    def test_annual_salary_range(self) -> None:
        job: dict[str, Any] = {
            "shouldDisplayCompensationOnJobPostings": True,
            "compensation": {
                "compensationTierSummary": "$150K – $200K • Offers Equity",
                "scrapeableCompensationSalarySummary": "$150K - $200K",
                "compensationTiers": [],
                "summaryComponents": [],
            },
        }
        assert _format_compensation(job) == "$150K - $200K"

    def test_hourly_rate(self) -> None:
        job: dict[str, Any] = {
            "shouldDisplayCompensationOnJobPostings": True,
            "compensation": {
                "compensationTierSummary": "$60/hr",
                "scrapeableCompensationSalarySummary": "$60/hr",
                "compensationTiers": [],
                "summaryComponents": [],
            },
        }
        assert _format_compensation(job) == "$60/hr"

    def test_display_false_returns_none(self) -> None:
        job: dict[str, Any] = {
            "shouldDisplayCompensationOnJobPostings": False,
            "compensation": {
                "compensationTierSummary": None,
                "scrapeableCompensationSalarySummary": None,
                "compensationTiers": [],
                "summaryComponents": [],
            },
        }
        assert _format_compensation(job) is None

    def test_no_compensation_key_returns_none(self) -> None:
        job: dict[str, Any] = {
            "shouldDisplayCompensationOnJobPostings": True,
        }
        assert _format_compensation(job) is None

    def test_null_summaries_returns_none(self) -> None:
        job: dict[str, Any] = {
            "shouldDisplayCompensationOnJobPostings": True,
            "compensation": {
                "compensationTierSummary": None,
                "scrapeableCompensationSalarySummary": None,
                "compensationTiers": [],
                "summaryComponents": [],
            },
        }
        assert _format_compensation(job) is None

    def test_fallback_to_tier_summary(self) -> None:
        job: dict[str, Any] = {
            "shouldDisplayCompensationOnJobPostings": True,
            "compensation": {
                "compensationTierSummary": "$120K – $160K • Offers Equity",
                "scrapeableCompensationSalarySummary": None,
                "compensationTiers": [],
                "summaryComponents": [],
            },
        }
        assert _format_compensation(job) == "$120K – $160K • Offers Equity"


# ── Location extraction tests ───────────────────────────────────────


class TestExtractLocations:
    def test_primary_only(self) -> None:
        job: dict[str, Any] = {
            "location": "New York, NY",
            "secondaryLocations": [],
        }
        assert _extract_locations(job) == ["New York, NY"]

    def test_primary_and_secondary(self) -> None:
        job: dict[str, Any] = {
            "location": "New York, NY",
            "secondaryLocations": [
                {"location": "San Francisco, CA"},
                {"location": "Miami, FL"},
            ],
        }
        assert _extract_locations(job) == [
            "New York, NY",
            "San Francisco, CA",
            "Miami, FL",
        ]

    def test_empty_location_returns_empty(self) -> None:
        job: dict[str, Any] = {
            "location": "",
            "secondaryLocations": [],
        }
        assert _extract_locations(job) == []

    def test_no_location_key(self) -> None:
        job: dict[str, Any] = {
            "secondaryLocations": [],
        }
        assert _extract_locations(job) == []


# ── Normalize tests ─────────────────────────────────────────────────


class TestAshbyNormalize:
    def test_all_posting_fields_populated(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        job = fixture["jobs"][0]
        raw = adapter._parse_job(job, company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.id == compute_posting_id(
            "ashby", "testco", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        )
        assert posting.id == "bef0b1c264d442cb"
        assert posting.company == "TestCo"
        assert posting.company_slug == "testco"
        assert posting.title == "Software Engineer, Backend"
        assert posting.location == "New York, NY"
        assert posting.locations == ["New York, NY", "San Francisco, CA"]
        assert posting.url == (
            "https://jobs.ashbyhq.com/testco/"
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        )
        assert posting.source == "ashby"
        assert posting.source_job_id == "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        assert posting.ats == "ashby"
        assert posting.posted_at == "2026-06-15T14:30:00.000+00:00"
        assert posting.first_seen_at == NOW
        assert posting.last_seen_at == NOW
        assert posting.closed_at is None

    def test_posting_id_deterministic(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        job = fixture["jobs"][1]
        raw = adapter._parse_job(job, company)
        posting = adapter.normalize(raw, company, NOW)

        expected_id = compute_posting_id(
            "ashby", "testco", "b2c3d4e5-f6a7-8901-bcde-f12345678901"
        )
        assert posting.id == expected_id
        assert posting.id == "40b9b41eba59f165"

    def test_all_fixture_jobs_normalize(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        for job in fixture["jobs"]:
            raw = adapter._parse_job(job, company)
            posting = adapter.normalize(raw, company, NOW)
            assert posting.id
            assert len(posting.id) == 16
            assert posting.company == "TestCo"
            assert posting.source == "ashby"
            assert posting.ats == "ashby"

    def test_no_compensation_board_normalizes(self) -> None:
        fixture = _load_fixture("no_compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company(slug="noco", name="NoCo")

        for job in fixture["jobs"]:
            raw = adapter._parse_job(job, company)
            posting = adapter.normalize(raw, company, NOW)
            assert posting.id
            assert len(posting.id) == 16
            assert posting.source == "ashby"
            assert posting.compensation is None


# ── Compensation on posting tests ───────────────────────────────────


class TestCompensationOnPosting:
    def test_compensation_present_on_posting(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        job = fixture["jobs"][0]
        raw = adapter._parse_job(job, company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.compensation == "$150K - $200K"

    def test_hourly_compensation_on_posting(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        intern_job = fixture["jobs"][3]
        raw = adapter._parse_job(intern_job, company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.compensation == "$60/hr"

    def test_compensation_absent_is_none(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        designer_job = fixture["jobs"][2]
        assert designer_job["shouldDisplayCompensationOnJobPostings"] is False

        raw = adapter._parse_job(designer_job, company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.compensation is None

    def test_salary_only_no_equity_label(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        ds_job = fixture["jobs"][4]
        raw = adapter._parse_job(ds_job, company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.compensation == "$130K - $170K"

    def test_compensation_in_to_dict(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture["jobs"][0], company)
        posting = adapter.normalize(raw, company, NOW)
        d = posting.to_dict()

        assert d["compensation"] == "$150K - $200K"

    def test_no_compensation_excluded_from_to_dict(self) -> None:
        fixture = _load_fixture("no_compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company(slug="noco", name="NoCo")

        raw = adapter._parse_job(fixture["jobs"][0], company)
        posting = adapter.normalize(raw, company, NOW)
        d = posting.to_dict()

        assert "compensation" not in d


# ── Null field handling tests ───────────────────────────────────────


class TestNullFieldHandling:
    def test_null_published_at_becomes_none(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        ds_job = fixture["jobs"][4]
        assert ds_job["publishedAt"] is None

        raw = adapter._parse_job(ds_job, company)
        assert raw.posted_at is None

        posting = adapter.normalize(raw, company, NOW)
        assert posting.posted_at is None

    def test_description_from_description_plain(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture["jobs"][0], company)
        assert "backend engineer" in raw.description
        assert "scalable services & APIs" in raw.description

    def test_job_url_used_not_apply_url(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture["jobs"][0], company)
        assert raw.url.startswith("https://jobs.ashbyhq.com/testco/")
        assert "/application" not in raw.url


# ── Secondary locations tests ───────────────────────────────────────


class TestSecondaryLocations:
    def test_multiple_secondary_locations(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        intern_job = fixture["jobs"][3]
        raw = adapter._parse_job(intern_job, company)

        assert len(raw.locations) == 3
        assert raw.locations[0] == "New York, NY"
        assert raw.locations[1] == "San Francisco, CA"
        assert raw.locations[2] == "Miami, FL"

    def test_no_secondary_locations(self) -> None:
        fixture = _load_fixture("compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company()

        ml_job = fixture["jobs"][1]
        raw = adapter._parse_job(ml_job, company)

        assert raw.locations == ["San Francisco, CA"]

    def test_secondary_from_no_comp_board(self) -> None:
        fixture = _load_fixture("no_compensation_board.json")
        adapter = AshbyAdapter()
        company = _make_company(slug="noco", name="NoCo")

        devops_job = fixture["jobs"][1]
        raw = adapter._parse_job(devops_job, company)

        assert raw.locations == ["Austin, TX", "Denver, CO"]
