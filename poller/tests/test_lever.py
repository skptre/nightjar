from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import USER_AGENT, RateLimitedClient
from poller.models import Company, SourceConfig, compute_posting_id
from poller.sources.lever import LeverAdapter, _ms_to_iso

FIXTURES = Path(__file__).parent / "fixtures" / "lever"


def _load_fixture(name: str) -> list[dict[str, Any]]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _make_company(
    slug: str = "palantir", name: str = "Palantir", eu: bool = False,
) -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["defense"],
        sources=[SourceConfig(type="lever", board_token=slug, eu=eu)],
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


class TestMsToIso:
    def test_known_epoch(self) -> None:
        assert _ms_to_iso(1672531200000) == "2023-01-01T00:00:00Z"

    def test_nonzero_time(self) -> None:
        assert _ms_to_iso(1711403416463) == "2024-03-25T21:50:16Z"

    def test_zero_epoch(self) -> None:
        assert _ms_to_iso(0) == "1970-01-01T00:00:00Z"


class TestLeverFetch:
    @pytest.mark.asyncio
    async def test_normal_board_returns_all_jobs(self) -> None:
        fixture = _load_fixture("normal_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert len(raw_postings) == 12
        assert not adapter.potentially_truncated
        await client.close()

    @pytest.mark.asyncio
    async def test_request_url_contains_slug(self) -> None:
        transport = MockTransport([_json_response([])])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert "api.lever.co" in str(request.url)
        assert "/palantir" in str(request.url)
        await client.close()

    @pytest.mark.asyncio
    async def test_mode_json_param_in_request(self) -> None:
        transport = MockTransport([_json_response([])])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert b"mode=json" in request.url.raw_path
        await client.close()

    @pytest.mark.asyncio
    async def test_eu_board_uses_eu_endpoint(self) -> None:
        transport = MockTransport([_json_response([])])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company(slug="eu-company", eu=True)
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert "api.eu.lever.co" in str(request.url)
        await client.close()

    @pytest.mark.asyncio
    async def test_non_eu_board_uses_us_endpoint(self) -> None:
        transport = MockTransport([_json_response([])])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company(eu=False)
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert "api.lever.co" in str(request.url)
        assert "api.eu.lever.co" not in str(request.url)
        await client.close()

    @pytest.mark.asyncio
    async def test_empty_board_returns_empty_list(self) -> None:
        transport = MockTransport([_json_response([])])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert raw_postings == []
        assert not adapter.potentially_truncated
        await client.close()

    @pytest.mark.asyncio
    async def test_http_500_raises_source_fetch_error(self) -> None:
        transport = MockTransport([
            _json_response({"error": "server error"}, status=500),
            _json_response({"error": "server error"}, status=500),
            _json_response({"error": "server error"}, status=500),
        ])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        with pytest.raises(SourceFetchError):
            await adapter.fetch(client, company, source)
        await client.close()

    @pytest.mark.asyncio
    async def test_non_array_response_raises_parse_error(self) -> None:
        transport = MockTransport([_json_response({"jobs": []})])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        with pytest.raises(SourceParseError, match="expected JSON array"):
            await adapter.fetch(client, company, source)
        await client.close()


class TestLeverPagination:
    @pytest.mark.asyncio
    async def test_two_pages_fetched(self) -> None:
        page1 = _load_fixture("paginated_page1.json")
        page2 = _load_fixture("paginated_page2.json")
        transport = MockTransport([
            _json_response(page1),
            _json_response(page2),
        ])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company(slug="testco", name="TestCo")
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert len(raw_postings) == 150
        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_pagination_skip_increments(self) -> None:
        page1 = _load_fixture("paginated_page1.json")
        page2 = _load_fixture("paginated_page2.json")
        transport = MockTransport([
            _json_response(page1),
            _json_response(page2),
        ])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company(slug="testco", name="TestCo")
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        req1 = transport.requests[0]
        req2 = transport.requests[1]
        assert b"skip=0" in req1.url.raw_path
        assert b"skip=100" in req2.url.raw_path
        await client.close()


class TestLeverTruncation:
    @pytest.mark.asyncio
    async def test_250_postings_sets_truncated_flag(self) -> None:
        page1 = _load_fixture("truncation_page1.json")
        page2 = _load_fixture("truncation_page2.json")
        page3 = _load_fixture("truncation_page3.json")
        transport = MockTransport([
            _json_response(page1),
            _json_response(page2),
            _json_response(page3),
        ])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company(slug="bigco", name="BigCo")
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert len(raw_postings) == 250
        assert adapter.potentially_truncated is True
        await client.close()

    @pytest.mark.asyncio
    async def test_below_threshold_not_truncated(self) -> None:
        fixture = _load_fixture("normal_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = LeverAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        assert adapter.potentially_truncated is False
        await client.close()


class TestLeverNormalize:
    def test_all_posting_fields_populated(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture[0], company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.id == compute_posting_id(
            "lever", "palantir", "ac978161-6f46-4f6b-ad9e-a258e642751c"
        )
        assert posting.id == "5859a5c9faee38fa"
        assert posting.company == "Palantir"
        assert posting.company_slug == "palantir"
        assert posting.title == "Administrative Business Partner"
        assert posting.location == "London, United Kingdom"
        assert posting.locations == ["London, United Kingdom"]
        assert posting.url == (
            "https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c"
        )
        assert posting.source == "lever"
        assert posting.source_job_id == "ac978161-6f46-4f6b-ad9e-a258e642751c"
        assert posting.ats == "lever"
        assert posting.first_seen_at == NOW
        assert posting.last_seen_at == NOW
        assert posting.closed_at is None

    def test_hosted_url_used_not_apply_url(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture[0], company)
        assert raw.url == (
            "https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c"
        )
        assert "/apply" not in raw.url

    def test_created_at_millisecond_conversion(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        swe_job = fixture[1]
        assert swe_job["createdAt"] == 1672531200000

        raw = adapter._parse_job(swe_job, company)
        assert raw.posted_at == "2023-01-01T00:00:00Z"

    def test_null_created_at_becomes_none(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        null_created_job = fixture[11]
        assert null_created_job["createdAt"] is None

        raw = adapter._parse_job(null_created_job, company)
        assert raw.posted_at is None

    def test_multiple_locations(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        multi_loc_job = fixture[1]
        raw = adapter._parse_job(multi_loc_job, company)

        assert raw.locations == ["Palo Alto, CA", "New York, NY"]

    def test_empty_location_defaults(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        empty_loc_job = fixture[11]
        raw = adapter._parse_job(empty_loc_job, company)

        assert raw.location == ""
        assert raw.locations == []

    def test_description_from_description_plain(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture[0], company)
        assert "world-changing company" in raw.description

    def test_posting_id_deterministic(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        raw = adapter._parse_job(fixture[2], company)
        posting = adapter.normalize(raw, company, NOW)

        expected_id = compute_posting_id(
            "lever", "palantir", "fe2a8c69-49b7-405f-816c-a6c6f894399a"
        )
        assert posting.id == expected_id
        assert posting.id == "5dc245b8fad2d414"

    def test_all_fixture_jobs_normalize(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = LeverAdapter()
        company = _make_company()

        for job in fixture:
            raw = adapter._parse_job(job, company)
            posting = adapter.normalize(raw, company, NOW)
            assert posting.id
            assert len(posting.id) == 16
            assert posting.source == "lever"
            assert posting.ats == "lever"
            assert posting.company == "Palantir"
