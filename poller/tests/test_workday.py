from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from poller.exceptions import SourceFetchError
from poller.models import Company, SourceConfig
from poller.sources.workday import (
    WORKDAY_PAGE_LIMIT,
    WorkdayAdapter,
    parse_board_token,
)
from poller.tests.conftest import MockTransport, json_response, make_mock_client

FIXTURES = Path(__file__).parent / "fixtures" / "workday"
NOW = "2026-08-21T12:00:00Z"


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _make_company(
    slug: str = "nvidia",
    name: str = "NVIDIA",
    board_token: str = "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
) -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["gpu", "ai"],
        sources=[SourceConfig(type="workday", board_token=board_token)],
    )


class TestParseBoardToken:
    def test_nvidia(self) -> None:
        host, tenant, site = parse_board_token(
            "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
        )
        assert host == "nvidia.wd5.myworkdayjobs.com"
        assert tenant == "nvidia"
        assert site == "NVIDIAExternalCareerSite"

    def test_intel(self) -> None:
        host, tenant, site = parse_board_token(
            "intel.wd1.myworkdayjobs.com/External"
        )
        assert host == "intel.wd1.myworkdayjobs.com"
        assert tenant == "intel"
        assert site == "External"

    def test_capital_one(self) -> None:
        host, tenant, site = parse_board_token(
            "capitalone.wd12.myworkdayjobs.com/Capital_One"
        )
        assert host == "capitalone.wd12.myworkdayjobs.com"
        assert tenant == "capitalone"
        assert site == "Capital_One"

    def test_invalid_format_raises(self) -> None:
        with pytest.raises(ValueError, match="invalid Workday board_token"):
            parse_board_token("not-a-workday-url")

    def test_missing_site_raises(self) -> None:
        with pytest.raises(ValueError, match="invalid Workday board_token"):
            parse_board_token("nvidia.wd5.myworkdayjobs.com")


class TestWorkdayPagination:
    @pytest.mark.asyncio
    async def test_multipage_collects_all_postings(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        page2 = _load_fixture("multipage_page2.json")
        page3 = _load_fixture("multipage_page3.json")
        transport = MockTransport([
            json_response(page1),
            json_response(page2),
            json_response(page3),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 55
        assert len(transport.requests) == 3
        await client.close()

    @pytest.mark.asyncio
    async def test_three_post_requests_made(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        page2 = _load_fixture("multipage_page2.json")
        page3 = _load_fixture("multipage_page3.json")
        transport = MockTransport([
            json_response(page1),
            json_response(page2),
            json_response(page3),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            await adapter.fetch(client, company, company.sources[0])

        for req in transport.requests:
            assert req.method == "POST"
        await client.close()


class TestLimitCap:
    @pytest.mark.asyncio
    async def test_limit_always_20(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        page2 = _load_fixture("multipage_page2.json")
        page3 = _load_fixture("multipage_page3.json")
        transport = MockTransport([
            json_response(page1),
            json_response(page2),
            json_response(page3),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            await adapter.fetch(client, company, company.sources[0])

        for req in transport.requests:
            body = json.loads(req.content.decode())
            assert body["limit"] == WORKDAY_PAGE_LIMIT
            assert body["limit"] == 20
        await client.close()

    @pytest.mark.asyncio
    async def test_offset_increments_by_20(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        page2 = _load_fixture("multipage_page2.json")
        page3 = _load_fixture("multipage_page3.json")
        transport = MockTransport([
            json_response(page1),
            json_response(page2),
            json_response(page3),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            await adapter.fetch(client, company, company.sources[0])

        bodies = [json.loads(r.content.decode()) for r in transport.requests]
        assert bodies[0]["offset"] == 0
        assert bodies[1]["offset"] == 20
        assert bodies[2]["offset"] == 40
        await client.close()


class TestEmptyBoard:
    @pytest.mark.asyncio
    async def test_empty_board_returns_empty_list(self) -> None:
        fixture = _load_fixture("empty_board.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw = await adapter.fetch(client, company, company.sources[0])

        assert raw == []
        assert len(transport.requests) == 1
        await client.close()


class TestThrottleRetry:
    @pytest.mark.asyncio
    async def test_throttled_page_retries_and_succeeds(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        throttled = _load_fixture("throttle_page2_empty.json")
        retry_success = _load_fixture("throttle_page2_retry.json")
        page3 = _load_fixture("multipage_page3.json")

        transport = MockTransport([
            json_response(page1),
            json_response(throttled),
            json_response(retry_success),
            json_response(page3),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 55
        assert len(transport.requests) == 4
        await client.close()

    @pytest.mark.asyncio
    async def test_exhausted_throttle_retries_raises(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        throttled = _load_fixture("throttle_page2_empty.json")

        transport = MockTransport([
            json_response(page1),
            json_response(throttled),
            json_response(throttled),
            json_response(throttled),
            json_response(throttled),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with (
            patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock),
            pytest.raises(SourceFetchError, match="empty page"),
        ):
            await adapter.fetch(client, company, company.sources[0])
        await client.close()


class TestTerminateCondition:
    @pytest.mark.asyncio
    async def test_stops_when_offset_plus_limit_gte_total(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 8
        assert len(transport.requests) == 1
        await client.close()


class TestUrlConstruction:
    @pytest.mark.asyncio
    async def test_api_url_format(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            await adapter.fetch(client, company, company.sources[0])

        request_url = str(transport.requests[0].url)
        assert "nvidia.wd5.myworkdayjobs.com" in request_url
        assert "/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs" in request_url
        await client.close()

    @pytest.mark.asyncio
    async def test_posting_url_is_public(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw = await adapter.fetch(client, company, company.sources[0])

        for posting in raw:
            assert posting.url.startswith("https://nvidia.wd5.myworkdayjobs.com/")
            assert "/wday/cxs/" not in posting.url
        await client.close()


class TestNormalization:
    @pytest.mark.asyncio
    async def test_normalize_produces_valid_posting(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw_postings = await adapter.fetch(client, company, company.sources[0])

        posting = adapter.normalize(raw_postings[0], company, NOW)
        assert posting.source == "workday"
        assert posting.ats == "workday"
        assert posting.company == "NVIDIA"
        assert posting.company_slug == "nvidia"
        assert posting.first_seen_at == NOW
        assert posting.last_seen_at == NOW
        assert posting.posted_at is None
        assert len(posting.id) == 16
        assert all(c in "0123456789abcdef" for c in posting.id)
        await client.close()

    @pytest.mark.asyncio
    async def test_source_job_id_from_external_path(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw_postings = await adapter.fetch(client, company, company.sources[0])

        assert raw_postings[0].source_job_id == "JR100000"
        await client.close()

    @pytest.mark.asyncio
    async def test_location_from_bullet_fields(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw_postings = await adapter.fetch(client, company, company.sources[0])

        first = raw_postings[0]
        assert first.location != ""
        assert "Full time" not in first.location
        assert "Posted" not in first.location
        await client.close()


class TestPerPageDelay:
    @pytest.mark.asyncio
    async def test_sleep_called_between_pages(self) -> None:
        page1 = _load_fixture("multipage_page1.json")
        page2 = _load_fixture("multipage_page2.json")
        page3 = _load_fixture("multipage_page3.json")
        transport = MockTransport([
            json_response(page1),
            json_response(page2),
            json_response(page3),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await adapter.fetch(client, company, company.sources[0])

        sleep_calls = [
            call.args[0] for call in mock_sleep.call_args_list
            if call.args and call.args[0] >= 1.0
        ]
        assert len(sleep_calls) >= 2
        for delay in sleep_calls:
            assert delay >= 1.0
        await client.close()


class TestHttpError:
    @pytest.mark.asyncio
    async def test_http_500_raises_source_fetch_error(self) -> None:
        transport = MockTransport([
            httpx.Response(
                status_code=500,
                headers={"content-type": "application/json"},
                content=b'{"error": "Internal Server Error"}',
            ),
            httpx.Response(
                status_code=500,
                headers={"content-type": "application/json"},
                content=b'{"error": "Internal Server Error"}',
            ),
            httpx.Response(
                status_code=500,
                headers={"content-type": "application/json"},
                content=b'{"error": "Internal Server Error"}',
            ),
        ])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with (
            patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock),
            pytest.raises(SourceFetchError),
        ):
            await adapter.fetch(client, company, company.sources[0])
        await client.close()
