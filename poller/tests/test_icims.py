from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import httpx
import pytest

from poller.filter import is_us_location
from poller.models import Company, SourceConfig, compute_posting_id
from poller.sources.icims import ICIMSAdapter, _Card, _format_location
from poller.tests.conftest import MockTransport as BaseTransport
from poller.tests.conftest import html_response, make_mock_client


class MockTransport(BaseTransport):
    def __init__(self, responses: list[httpx.Response]) -> None:
        super().__init__([html_response("User-agent: *\nAllow: /"), *responses])


FIXTURES = Path(__file__).parent / "fixtures" / "icims"
NOW = "2026-09-08T18:00:00Z"


def _html(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _company(slug: str = "testco", name: str = "TestCo") -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["aerospace"],
        sources=[SourceConfig(type="icims", board_token="testco")],
    )


class TestICIMSFetch:
    @pytest.mark.asyncio
    async def test_parses_cards_from_page(self) -> None:
        transport = MockTransport(
            [
                html_response(_html("search_page1.html")),
                html_response(_html("empty.html")),
            ]
        )
        client = await make_mock_client(transport)
        raw = await ICIMSAdapter().fetch(client, _company(), _company().sources[0])
        assert len(raw) == 2
        first = raw[0]
        assert first.source_job_id == "5010"
        assert first.title == "Manufacturing Engineering Intern"
        assert first.location == "Marina, CA"
        assert first.url == (
            "https://careers-testco.icims.com/jobs/5010/manufacturing-engineering-intern/job"
        )
        await client.close()

    @pytest.mark.asyncio
    async def test_pagination_across_pages(self) -> None:
        transport = MockTransport(
            [
                html_response(_html("search_page1.html")),
                html_response(_html("search_page2.html")),
                html_response(_html("empty.html")),
            ]
        )
        client = await make_mock_client(transport)
        raw = await ICIMSAdapter().fetch(client, _company(), _company().sources[0])
        assert {r.source_job_id for r in raw} == {"5010", "5011", "5099"}
        await client.close()

    @pytest.mark.asyncio
    async def test_terminates_when_page_repeats(self) -> None:
        # MockTransport repeats the last response; identical ids -> no new -> stop.
        transport = MockTransport([html_response(_html("search_page1.html"))])
        client = await make_mock_client(transport)
        raw = await ICIMSAdapter().fetch(client, _company(), _company().sources[0])
        assert len(raw) == 2
        assert len(transport.requests) == 3  # page 0 (new) + page 1 (repeat -> stop)
        await client.close()

    @pytest.mark.asyncio
    async def test_empty_first_page_returns_empty(self) -> None:
        transport = MockTransport([html_response(_html("empty.html"))])
        client = await make_mock_client(transport)
        raw = await ICIMSAdapter().fetch(client, _company(), _company().sources[0])
        assert raw == []
        await client.close()

    @pytest.mark.asyncio
    async def test_pr_param_in_request(self) -> None:
        transport = MockTransport(
            [
                html_response(_html("search_page1.html")),
                html_response(_html("empty.html")),
            ]
        )
        client = await make_mock_client(transport)
        await ICIMSAdapter().fetch(client, _company(), _company().sources[0])
        assert "pr=0" in str(transport.requests[1].url)
        assert "careers-testco.icims.com" in str(transport.requests[1].url)
        await client.close()


class TestICIMSNormalize:
    def test_normalize_fields(self) -> None:
        adapter = ICIMSAdapter()
        company = _company()
        card = _Card(
            job_id="5010",
            url="https://careers-testco.icims.com/jobs/5010/x/job",
            title_parts=["Manufacturing Engineering Intern"],
            location="US-CA-Marina",
        )
        raw = adapter._parse_card(card, company)
        posting = adapter.normalize(raw, company, NOW)
        assert posting.id == compute_posting_id("icims", "testco", "5010")
        assert posting.ats == "icims"
        assert posting.source == "icims"
        assert posting.location == "Marina, CA"
        assert posting.company == "TestCo"
        assert posting.first_seen_at == NOW

    def test_parsed_locations_pass_us_filter(self) -> None:
        # The whole point: iCIMS US-XX codes must survive filter_us_locations.
        assert is_us_location("Marina, CA", ["Marina, CA"])
        assert is_us_location("Houston, TX", ["Houston, TX"])


class TestFormatLocation:
    def test_us_code(self) -> None:
        assert _format_location("US-CA-Marina") == "Marina, CA"

    def test_us_code_multiword_city(self) -> None:
        assert _format_location("US-NY-New York") == "New York, NY"

    def test_empty(self) -> None:
        assert _format_location("") == ""

    def test_non_us_passthrough(self) -> None:
        assert _format_location("Remote") == "Remote"


@pytest.mark.asyncio
async def test_icims_unrecognized_html_is_not_an_empty_board() -> None:
    from poller.exceptions import SourceParseError

    client = await make_mock_client(
        MockTransport([html_response("<h1>Service temporarily unavailable</h1>")])
    )
    try:
        with pytest.raises(SourceParseError):
            await ICIMSAdapter().fetch(client, _company(), _company().sources[0])
    finally:
        await client.close()
