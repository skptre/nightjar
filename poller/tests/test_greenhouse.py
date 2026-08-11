from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import USER_AGENT, RateLimitedClient
from poller.models import Company, SourceConfig, compute_posting_id
from poller.sources.greenhouse import (
    GreenhouseAdapter,
    _html_to_plaintext,
    _unescape_html,
)

FIXTURES = Path(__file__).parent / "fixtures" / "greenhouse"


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _make_company(slug: str = "watershed", name: str = "Watershed") -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["biotech"],
        sources=[SourceConfig(type="greenhouse", board_token=slug)],
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


class TestGreenhouseFetch:
    @pytest.mark.asyncio
    async def test_normal_board_returns_all_jobs(self) -> None:
        fixture = _load_fixture("normal_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        raw_postings = await adapter.fetch(client, company, source)

        assert len(raw_postings) == 5
        await client.close()

    @pytest.mark.asyncio
    async def test_content_true_param_in_request(self) -> None:
        fixture = _load_fixture("normal_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert b"content=true" in request.url.raw_path
        await client.close()

    @pytest.mark.asyncio
    async def test_request_url_contains_board_token(self) -> None:
        fixture = _load_fixture("normal_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        await adapter.fetch(client, company, source)

        request = transport.requests[0]
        assert "boards-api.greenhouse.io" in str(request.url)
        assert "/watershed/" in str(request.url)
        await client.close()

    @pytest.mark.asyncio
    async def test_empty_board_returns_empty_list(self) -> None:
        fixture = _load_fixture("empty_board.json")
        transport = MockTransport([_json_response(fixture)])
        client = await _make_client_with_transport(transport)
        adapter = GreenhouseAdapter()
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
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        with pytest.raises(SourceFetchError):
            await adapter.fetch(client, company, source)
        await client.close()

    @pytest.mark.asyncio
    async def test_malformed_response_raises_parse_error(self) -> None:
        transport = MockTransport([_json_response({"not_jobs": []})])
        client = await _make_client_with_transport(transport)
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        with pytest.raises(SourceParseError, match="expected object with 'jobs' key"):
            await adapter.fetch(client, company, source)
        await client.close()


class TestGreenhouseNormalize:
    def test_all_posting_fields_populated(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        job = fixture["jobs"][0]
        raw = adapter._parse_job(job, company, source)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.id == compute_posting_id("greenhouse", "watershed", "6216631003")
        assert posting.id == "87de8d3a4c80fe19"
        assert posting.company == "Watershed"
        assert posting.company_slug == "watershed"
        assert posting.title == "Customer Success Engineer, Bioinformatics"
        assert posting.location == "Cambridge, MA"
        assert posting.locations == ["Boston, Massachusetts, United States"]
        assert posting.url == "https://boards.greenhouse.io/watershed/jobs/6216631003"
        assert posting.source == "greenhouse"
        assert posting.source_job_id == "6216631003"
        assert posting.ats == "greenhouse"
        assert posting.posted_at == "2024-09-23T16:50:04-04:00"
        assert posting.first_seen_at == NOW
        assert posting.last_seen_at == NOW
        assert posting.closed_at is None

    def test_posting_id_deterministic(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        job = fixture["jobs"][1]
        raw = adapter._parse_job(job, company, source)
        posting = adapter.normalize(raw, company, NOW)

        expected_id = compute_posting_id("greenhouse", "watershed", "4254074003")
        assert posting.id == expected_id
        assert posting.id == "2065c266d6276bec"

    def test_all_fixture_jobs_normalize(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        for job in fixture["jobs"]:
            raw = adapter._parse_job(job, company, source)
            posting = adapter.normalize(raw, company, NOW)
            assert posting.id
            assert len(posting.id) == 16
            assert posting.company == "Watershed"
            assert posting.source == "greenhouse"
            assert posting.ats == "greenhouse"


class TestNullLocation:
    def test_null_location_returns_empty_string(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        null_loc_job = fixture["jobs"][4]
        assert null_loc_job["location"] is None

        raw = adapter._parse_job(null_loc_job, company, source)
        assert raw.location == ""

        posting = adapter.normalize(raw, company, NOW)
        assert posting.location == ""

    def test_null_location_uses_offices_for_locations(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        null_loc_job = fixture["jobs"][4]
        raw = adapter._parse_job(null_loc_job, company, source)

        assert len(raw.locations) == 2
        assert "New York, New York, United States" in raw.locations
        assert "San Francisco, California, United States" in raw.locations


class TestMultipleOffices:
    def test_multiple_offices_populate_locations(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        multi_office_job = fixture["jobs"][4]
        raw = adapter._parse_job(multi_office_job, company, source)

        assert len(raw.locations) == 2
        assert raw.locations[0] == "New York, New York, United States"
        assert raw.locations[1] == "San Francisco, California, United States"


class TestNullPostedAt:
    def test_null_first_published_becomes_none(self) -> None:
        fixture = _load_fixture("normal_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        intern_job = fixture["jobs"][4]
        assert intern_job["first_published"] is None

        raw = adapter._parse_job(intern_job, company, source)
        assert raw.posted_at is None

        posting = adapter.normalize(raw, company, NOW)
        assert posting.posted_at is None


class TestHtmlEntityDecoding:
    def test_single_encoded_entities_unescaped(self) -> None:
        result = _html_to_plaintext("&lt;p&gt;Hello &amp; world&lt;/p&gt;")
        assert "&amp;" not in result
        assert "&lt;" not in result
        assert "&gt;" not in result
        assert "&" in result
        assert "Hello" in result
        assert "world" in result

    def test_double_encoded_ampersand(self) -> None:
        result = _html_to_plaintext(
            "&lt;p&gt;Assess &amp;amp; combine data.&lt;/p&gt;"
        )
        assert "&amp;" not in result
        assert "Assess & combine data." in result

    def test_double_encoded_quotes(self) -> None:
        result = _html_to_plaintext(
            '&lt;p&gt;&amp;amp;quot;big data&amp;amp;quot; systems&lt;/p&gt;'
        )
        assert "&amp;" not in result
        assert "&quot;" not in result
        assert '"big data"' in result

    def test_nbsp_decoded(self) -> None:
        result = _html_to_plaintext("&lt;p&gt;Hello&amp;nbsp;world&lt;/p&gt;")
        assert "&nbsp;" not in result
        assert "&amp;" not in result

    def test_no_html_tags_survive(self) -> None:
        result = _html_to_plaintext(
            "&lt;h3&gt;Title&lt;/h3&gt;\n&lt;p&gt;Body text.&lt;/p&gt;"
        )
        assert "<" not in result
        assert ">" not in result
        assert "Title" in result
        assert "Body text." in result

    def test_whitespace_collapsed(self) -> None:
        result = _html_to_plaintext(
            "&lt;p&gt;Hello&lt;/p&gt;\n\n&lt;p&gt;World&lt;/p&gt;"
        )
        assert "  " not in result

    def test_content_capped_at_5000(self) -> None:
        long_content = "&lt;p&gt;" + "x" * 6000 + "&lt;/p&gt;"
        result = _html_to_plaintext(long_content)
        assert len(result) <= 5000

    def test_empty_content_returns_empty(self) -> None:
        result = _html_to_plaintext("")
        assert result == ""

    def test_fixture_entity_encoded_board_fully_decoded(self) -> None:
        fixture = _load_fixture("entity_encoded_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        for job in fixture["jobs"]:
            raw = adapter._parse_job(job, company, source)
            assert "&amp;" not in raw.description, (
                f"&amp; survived in {job['title']}: {raw.description[:100]}"
            )
            assert "&lt;" not in raw.description, (
                f"&lt; survived in {job['title']}: {raw.description[:100]}"
            )
            assert "&gt;" not in raw.description, (
                f"&gt; survived in {job['title']}: {raw.description[:100]}"
            )

    def test_rd_ampersand_decoded(self) -> None:
        fixture = _load_fixture("entity_encoded_board.json")
        adapter = GreenhouseAdapter()
        company = _make_company()
        source = company.sources[0]

        rd_job = fixture["jobs"][1]
        raw = adapter._parse_job(rd_job, company, source)
        assert "R&D" in raw.description


class TestUnescapeHtml:
    def test_single_pass(self) -> None:
        assert _unescape_html("&amp;") == "&"

    def test_double_encoding(self) -> None:
        assert _unescape_html("&amp;amp;") == "&"

    def test_triple_encoding(self) -> None:
        assert _unescape_html("&amp;amp;amp;") == "&"

    def test_already_clean(self) -> None:
        assert _unescape_html("hello world") == "hello world"

    def test_mixed_entities(self) -> None:
        result = _unescape_html("&lt;p&gt;a &amp;amp; b&lt;/p&gt;")
        assert result == "<p>a & b</p>"
