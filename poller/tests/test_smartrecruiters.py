from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from poller.models import Company, SourceConfig, compute_posting_id
from poller.sources.smartrecruiters import SmartRecruitersAdapter
from poller.tests.conftest import MockTransport, json_response, make_mock_client

FIXTURES = Path(__file__).parent / "fixtures" / "smartrecruiters"
NOW = "2026-08-21T12:00:00Z"


def _load_fixture(name: str) -> dict[str, Any]:
    result: dict[str, Any] = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return result


def _make_company(
    slug: str = "visa",
    name: str = "Visa Inc.",
    board_token: str = "Visa",
) -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["fintech"],
        sources=[SourceConfig(type="smartrecruiters", board_token=board_token)],
    )


@pytest.mark.asyncio()
class TestSmartRecruitersPagination:
    async def test_two_pages_all_postings_returned(self) -> None:
        page1 = _load_fixture("paginated_page1.json")
        page2 = _load_fixture("paginated_page2.json")
        transport = MockTransport([json_response(page1), json_response(page2)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 8
        await client.close()

    async def test_two_get_requests_made(self) -> None:
        page1 = _load_fixture("paginated_page1.json")
        page2 = _load_fixture("paginated_page2.json")
        transport = MockTransport([json_response(page1), json_response(page2)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        await adapter.fetch(client, company, company.sources[0])

        assert len(transport.requests) == 2
        await client.close()

    async def test_offset_params_correct(self) -> None:
        page1 = _load_fixture("paginated_page1.json")
        page2 = _load_fixture("paginated_page2.json")
        transport = MockTransport([json_response(page1), json_response(page2)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        await adapter.fetch(client, company, company.sources[0])

        req1_url = str(transport.requests[0].url)
        req2_url = str(transport.requests[1].url)
        assert "offset=0" in req1_url
        assert "offset=100" in req2_url
        assert "limit=100" in req1_url
        assert "limit=100" in req2_url
        await client.close()


@pytest.mark.asyncio()
class TestSmartRecruitersSinglePage:
    async def test_single_page_returns_all(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company(
            slug="testcorp", name="TestCorp", board_token="TestCorp",
        )

        raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 3
        assert len(transport.requests) == 1
        await client.close()


@pytest.mark.asyncio()
class TestSmartRecruitersEmptyBoard:
    async def test_empty_board_returns_empty_list(self) -> None:
        fixture = _load_fixture("empty_board.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert raw == []
        await client.close()


@pytest.mark.asyncio()
class TestSmartRecruitersUrlConstruction:
    async def test_api_url_contains_board_token(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company(board_token="Visa")

        await adapter.fetch(client, company, company.sources[0])

        req_url = str(transport.requests[0].url)
        assert "api.smartrecruiters.com/v1/companies/Visa/postings" in req_url
        await client.close()


class TestSmartRecruitersLocationFormatting:
    def test_city_and_region(self) -> None:
        adapter = SmartRecruitersAdapter()
        company = _make_company()
        item = {
            "id": "loc-1",
            "name": "Intern",
            "releasedDate": "2026-08-01T00:00:00Z",
            "location": {"city": "New York", "region": "NY", "country": "US"},
        }
        raw = adapter._parse_posting(item, company, "Visa")
        assert raw.location == "New York, NY, US"

    def test_city_only(self) -> None:
        adapter = SmartRecruitersAdapter()
        company = _make_company()
        item = {
            "id": "loc-2",
            "name": "Intern",
            "releasedDate": "2026-08-01T00:00:00Z",
            "location": {"city": "London", "region": "", "country": "UK"},
        }
        raw = adapter._parse_posting(item, company, "Visa")
        assert raw.location == "London, UK"

    def test_no_city_falls_back_to_country(self) -> None:
        adapter = SmartRecruitersAdapter()
        company = _make_company()
        item = {
            "id": "loc-3",
            "name": "Intern",
            "releasedDate": "2026-08-01T00:00:00Z",
            "location": {"city": "", "region": "", "country": "US"},
        }
        raw = adapter._parse_posting(item, company, "Visa")
        assert raw.location == "US"

    def test_no_location_object(self) -> None:
        adapter = SmartRecruitersAdapter()
        company = _make_company()
        item = {
            "id": "loc-4",
            "name": "Intern",
            "releasedDate": "2026-08-01T00:00:00Z",
        }
        raw = adapter._parse_posting(item, company, "Visa")
        assert raw.location == ""
        assert raw.locations == []


class TestSmartRecruitersNormalize:
    def _make_raw(self) -> Any:
        from poller.models import RawPosting

        return RawPosting(
            source="smartrecruiters",
            company_slug="visa",
            source_job_id="sr-001",
            title="Software Engineering Intern - Summer 2027",
            location="New York, NY",
            locations=["New York, NY"],
            url="https://jobs.smartrecruiters.com/Visa/sr-001",
            posted_at="2026-08-01T10:00:00Z",
            description="",
            raw_data={},
        )

    def test_produces_valid_posting(self) -> None:
        adapter = SmartRecruitersAdapter()
        raw = self._make_raw()
        company = _make_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.source == "smartrecruiters"
        assert posting.ats == "smartrecruiters"
        assert posting.company == "Visa Inc."
        assert posting.company_slug == "visa"
        assert posting.first_seen_at == NOW
        assert posting.last_seen_at == NOW
        assert len(posting.id) == 16

    def test_posting_url_is_public_url(self) -> None:
        adapter = SmartRecruitersAdapter()
        raw = self._make_raw()
        company = _make_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.url == "https://jobs.smartrecruiters.com/Visa/sr-001"

    def test_posting_id_deterministic(self) -> None:
        adapter = SmartRecruitersAdapter()
        raw = self._make_raw()
        company = _make_company()

        p1 = adapter.normalize(raw, company, NOW)
        p2 = adapter.normalize(raw, company, NOW)

        assert p1.id == p2.id

    def test_posting_id_uses_correct_source(self) -> None:
        adapter = SmartRecruitersAdapter()
        raw = self._make_raw()
        company = _make_company()

        posting = adapter.normalize(raw, company, NOW)

        expected = compute_posting_id("smartrecruiters", "visa", "sr-001")
        assert posting.id == expected

    def test_posted_at_preserved(self) -> None:
        adapter = SmartRecruitersAdapter()
        raw = self._make_raw()
        company = _make_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.posted_at == "2026-08-01T10:00:00Z"


class TestSmartRecruitersDetailDescription:
    def test_description_from_job_sections(self) -> None:
        adapter = SmartRecruitersAdapter()
        detail = _load_fixture("detail_response.json")

        from poller.models import RawPosting

        raw = RawPosting(
            source="smartrecruiters",
            company_slug="visa",
            source_job_id="sr-001",
            title="Software Engineering Intern - Summer 2027",
            location="New York, NY",
            locations=["New York, NY"],
            url="https://jobs.smartrecruiters.com/Visa/sr-001",
            posted_at="2026-08-01T10:00:00Z",
            description="",
            raw_data=detail,
        )
        company = _make_company()

        posting = adapter.normalize(raw, company, NOW)

        assert "Software Engineering Intern" in posting.description_text
        assert "Computer Science" in posting.description_text
        assert "<p>" not in posting.description_text
        assert "<strong>" not in posting.description_text

    def test_no_description_sections(self) -> None:
        adapter = SmartRecruitersAdapter()

        from poller.models import RawPosting

        raw = RawPosting(
            source="smartrecruiters",
            company_slug="visa",
            source_job_id="sr-001",
            title="Intern",
            location="NYC",
            locations=["NYC"],
            url="https://jobs.smartrecruiters.com/Visa/sr-001",
            posted_at=None,
            description="",
            raw_data={},
        )
        company = _make_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.description_text == ""


@pytest.mark.asyncio()
class TestSmartRecruitersParseError:
    async def test_non_dict_response_raises(self) -> None:
        transport = MockTransport([json_response([1, 2, 3])])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        from poller.exceptions import SourceParseError

        with pytest.raises(SourceParseError, match="expected object"):
            await adapter.fetch(client, company, company.sources[0])
        await client.close()

    async def test_malformed_posting_skipped(self) -> None:
        fixture = {
            "totalFound": 2,
            "content": [
                {"not_an_id": "broken"},
                {
                    "id": "good-1",
                    "name": "Valid Intern",
                    "releasedDate": "2026-08-01T00:00:00Z",
                    "location": {
                        "city": "NYC",
                        "region": "NY",
                        "country": "US",
                    },
                },
            ],
        }
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 1
        assert raw[0].source_job_id == "good-1"
        await client.close()


@pytest.mark.asyncio()
class TestSmartRecruitersHttpError:
    async def test_http_500_raises(self) -> None:
        transport = MockTransport([
            json_response({"error": "internal"}, status=500),
            json_response({"error": "internal"}, status=500),
            json_response({"error": "internal"}, status=500),
        ])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company()

        from poller.exceptions import SourceFetchError

        with pytest.raises(SourceFetchError):
            await adapter.fetch(client, company, company.sources[0])
        await client.close()


@pytest.mark.asyncio()
class TestSmartRecruitersFullPipeline:
    async def test_fixture_round_trip(self) -> None:
        fixture = _load_fixture("single_page.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SmartRecruitersAdapter()
        company = _make_company(
            slug="testcorp", name="TestCorp", board_token="TestCorp",
        )

        raw_postings = await adapter.fetch(client, company, company.sources[0])
        postings = [adapter.normalize(raw, company, NOW) for raw in raw_postings]

        assert len(postings) == 3
        for p in postings:
            assert p.source == "smartrecruiters"
            assert p.ats == "smartrecruiters"
            assert len(p.id) == 16
            assert "jobs.smartrecruiters.com" in p.url
            assert p.posted_at is not None
            assert p.location != ""
        await client.close()
