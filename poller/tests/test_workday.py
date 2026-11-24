from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from poller.exceptions import SourceFetchError, SourceParseError
from poller.models import Company, SourceConfig
from poller.sources.workday import (
    WORKDAY_PAGE_LIMIT,
    WorkdayAdapter,
    build_public_url,
    parse_board_token,
)
from poller.tests.conftest import MockTransport, json_response, make_mock_client

FIXTURES = Path(__file__).parent / "fixtures" / "workday"
NOW = "2026-08-21T12:00:00Z"


@pytest.mark.asyncio
@pytest.mark.parametrize('later_total', [0, None, 10])
async def test_keeps_first_total_when_later_pages_reset_it(later_total: int | None) -> None:
    pages = [_load_fixture(f'multipage_page{i}.json') for i in (1, 2, 3)]
    for page in pages[1:]:
        if later_total is None:
            page.pop('total', None)
        else:
            page['total'] = later_total
    client = await make_mock_client(MockTransport([json_response(p) for p in pages]))
    company = _make_company()
    try:
        rows = await WorkdayAdapter().fetch(client, company, company.sources[0])
        assert len({p.source_job_id for p in rows}) == 55
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_repeated_workday_page_is_not_a_complete_board() -> None:
    page = _load_fixture('multipage_page1.json')
    client = await make_mock_client(MockTransport([json_response(page)]))
    company = _make_company()
    try:
        adapter = WorkdayAdapter()
        rows = await adapter.fetch(client, company, company.sources[0])
        assert rows and adapter.potentially_truncated
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_workday_missing_jobs_field_is_not_an_empty_board() -> None:
    client = await make_mock_client(MockTransport([json_response({'error': 'schema changed'})]))
    company = _make_company()
    try:
        with pytest.raises(SourceParseError):
            await WorkdayAdapter().fetch(client, company, company.sources[0])
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_empty_first_page_retries_when_it_advertises_jobs() -> None:
    pages = [_load_fixture(f"multipage_page{i}.json") for i in (1, 2, 3)]
    responses = [{"total": 55, "jobPostings": []}, *pages]
    client = await make_mock_client(MockTransport([json_response(p) for p in responses]))
    company = _make_company()
    try:
        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            rows = await WorkdayAdapter().fetch(client, company, company.sources[0])
        assert len(rows) == 55
    finally:
        await client.close()


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

    def test_public_url_keeps_locale_before_site(self) -> None:
        assert build_public_url(
            "nvidia.wd5.myworkdayjobs.com",
            "NVIDIAExternalCareerSite",
            "/en-US/job/Santa-Clara/SWE-Intern_JR1",
        ) == (
            "https://nvidia.wd5.myworkdayjobs.com/en-US/"
            "NVIDIAExternalCareerSite/job/Santa-Clara/SWE-Intern_JR1"
        )


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
    async def test_exhausted_throttle_retries_retains_partial_discoveries(self) -> None:
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
        ):
            rows = await adapter.fetch(client, company, company.sources[0])
        assert len(rows) == 20 and adapter.potentially_truncated
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
            assert "/NVIDIAExternalCareerSite/" in posting.url
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
    async def test_location_prefers_locations_text(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw_postings = await adapter.fetch(client, company, company.sources[0])

        first = raw_postings[0]
        assert first.location == "Santa Clara, California, United States of America"
        await client.close()

    @pytest.mark.asyncio
    async def test_location_falls_back_to_bullet_fields(self) -> None:
        fixture = _load_fixture("single_page.json")
        fixture["jobPostings"][0].pop("locationsText")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = WorkdayAdapter()
        company = _make_company()

        with patch("poller.sources.workday.asyncio.sleep", new_callable=AsyncMock):
            raw_postings = await adapter.fetch(client, company, company.sources[0])

        assert raw_postings[0].location == (
            "Santa Clara, California, United States of America"
        )
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


@pytest.mark.asyncio
async def test_capped_workday_search_partitions_instead_of_repeating_first_page() -> None:
    def page(start: int, count: int, total: int) -> dict[str, Any]:
        return {"total": total, "jobPostings": [
            {"title": "Engineering Intern", "externalPath": f"/job/US-CA/Intern_JR{i}",
             "locationsText": "US, CA, Santa Clara"} for i in range(start, start + count)
        ]}
    root = page(0, 20, 40)
    root["facets"] = [{"facetParameter": "jobFamilyGroup", "values": [
        {"id": "engineering", "count": 30}, {"id": "university", "count": 25},
    ]}]
    responses = [root, page(30, 20, 25), page(50, 5, 0),
                 page(0, 20, 30), page(20, 10, 0)]
    transport = MockTransport([json_response(p) for p in responses])
    client = await make_mock_client(transport)
    company = _make_company()
    try:
        with patch("poller.sources.workday.WORKDAY_RESULT_CAP", 40):
            rows = await WorkdayAdapter().fetch(client, company, company.sources[0])
        assert len({p.source_job_id for p in rows}) == 55
        assert "Intern_JR54" in {p.source_job_id for p in rows}
        bodies = [json.loads(r.content) for r in transport.requests]
        assert bodies[1]["appliedFacets"] == {"jobFamilyGroup": ["university"]}
        assert bodies[3]["appliedFacets"] == {"jobFamilyGroup": ["engineering"]}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_unpartitionable_workday_cap_is_not_a_complete_result() -> None:
    page = _load_fixture("single_page.json")
    page["total"] = 2000
    client = await make_mock_client(MockTransport([json_response(page)]))
    company = _make_company()
    try:
        with pytest.raises(SourceParseError, match="cap"):
            await WorkdayAdapter().fetch(client, company, company.sources[0])
    finally:
        await client.close()
