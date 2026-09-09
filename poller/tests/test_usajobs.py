from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from poller.exceptions import SourceFetchError, SourceParseError
from poller.models import Company, SourceConfig, compute_posting_id
from poller.sources.usajobs import USAJobsAdapter, _extract_locations, _primary_location
from poller.tests.conftest import MockTransport, json_response, make_mock_client

FIXTURES = Path(__file__).parent / "fixtures" / "usajobs"
NOW = "2026-09-08T18:00:00Z"


def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _company(slug: str = "nasa-jpl", name: str = "NASA JPL") -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=["aerospace"],
        sources=[SourceConfig(type="usajobs", board_token="NN")],
    )


@pytest.fixture(autouse=True)
def _api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USAJOBS_API_KEY", "test-key-123")
    monkeypatch.setenv("USAJOBS_EMAIL", "dev@example.com")


class TestUSAJobsFetch:
    @pytest.mark.asyncio
    async def test_single_page_returns_all_items(self) -> None:
        transport = MockTransport([json_response(_load("single_page.json"))])
        client = await make_mock_client(transport)
        raw = await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
        assert len(raw) == 3
        await client.close()

    @pytest.mark.asyncio
    async def test_pagination_accumulates_across_pages(self) -> None:
        transport = MockTransport(
            [
                json_response(_load("page1.json")),
                json_response(_load("page2.json")),
            ]
        )
        client = await make_mock_client(transport)
        raw = await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
        assert len(raw) == 4
        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_empty_board_returns_empty(self) -> None:
        transport = MockTransport([json_response(_load("empty.json"))])
        client = await make_mock_client(transport)
        raw = await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
        assert raw == []
        await client.close()

    @pytest.mark.asyncio
    async def test_missing_api_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("USAJOBS_API_KEY", raising=False)
        transport = MockTransport([json_response(_load("single_page.json"))])
        client = await make_mock_client(transport)
        with pytest.raises(SourceFetchError, match="USAJOBS_API_KEY not set"):
            await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
        await client.close()

    @pytest.mark.asyncio
    async def test_auth_header_and_org_param_sent(self) -> None:
        transport = MockTransport([json_response(_load("single_page.json"))])
        client = await make_mock_client(transport)
        await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
        req = transport.requests[0]
        assert req.headers.get("Authorization-Key") == "test-key-123"
        assert "Organization=NN" in str(req.url)
        await client.close()

    @pytest.mark.asyncio
    async def test_malformed_response_raises_parse_error(self) -> None:
        transport = MockTransport([json_response({"nope": 1})])
        client = await make_mock_client(transport)
        with pytest.raises(SourceParseError, match="SearchResult"):
            await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
        await client.close()


class TestUSAJobsNormalize:
    def test_all_fields_populated(self) -> None:
        fixture = _load("single_page.json")
        adapter = USAJobsAdapter()
        company = _company()
        item = fixture["SearchResult"]["SearchResultItems"][0]
        raw = adapter._parse_job(item, company)
        posting = adapter.normalize(raw, company, NOW)

        assert posting.id == compute_posting_id("usajobs", "nasa-jpl", "829083500")
        assert posting.company == "NASA JPL"
        assert posting.title == "Student Trainee (Engineering)"
        assert posting.location == "Pasadena, California"
        assert posting.url == "https://www.usajobs.gov/job/829083500"
        assert posting.source == "usajobs"
        assert posting.ats == "usajobs"
        assert posting.posted_at == "2026-09-01"
        assert posting.valid_through == "2026-10-01"
        assert "internship" in posting.description_text
        assert posting.first_seen_at == NOW

    def test_multi_location_uses_first_when_display_is_multiple(self) -> None:
        fixture = _load("single_page.json")
        adapter = USAJobsAdapter()
        company = _company()
        item = fixture["SearchResult"]["SearchResultItems"][1]
        raw = adapter._parse_job(item, company)
        assert raw.locations == ["Houston, Texas", "Cleveland, Ohio"]
        assert raw.location == "Houston, Texas"

    def test_all_items_normalize_with_16char_ids(self) -> None:
        fixture = _load("single_page.json")
        adapter = USAJobsAdapter()
        company = _company()
        for item in fixture["SearchResult"]["SearchResultItems"]:
            raw = adapter._parse_job(item, company)
            posting = adapter.normalize(raw, company, NOW)
            assert len(posting.id) == 16
            assert posting.ats == "usajobs"


class TestHelpers:
    def test_extract_locations(self) -> None:
        desc = {
            "PositionLocation": [
                {"LocationName": "Pasadena, California"},
                {"LocationName": "Houston, Texas"},
            ]
        }
        assert _extract_locations(desc) == ["Pasadena, California", "Houston, Texas"]

    def test_primary_location_skips_multiple(self) -> None:
        desc = {"PositionLocationDisplay": "Multiple Locations"}
        assert _primary_location(desc, ["Houston, Texas"]) == "Houston, Texas"

    def test_primary_location_uses_display(self) -> None:
        desc = {"PositionLocationDisplay": "Pasadena, California"}
        assert _primary_location(desc, []) == "Pasadena, California"


def test_usajobs_retains_full_external_sections_and_marks_summary_partial() -> None:
    item = _load("single_page.json")["SearchResult"]["SearchResultItems"][0]
    adapter = USAJobsAdapter()
    assert (
        adapter.normalize(adapter._parse_job(item, _company()), _company(), NOW).description_status
        == "partial"
    )
    details = item["MatchedObjectDescriptor"]["UserArea"]["Details"]
    details.update(
        {
            "MajorDuties": "Design flight hardware.",
            "Education": "Must be enrolled.",
            "Requirements": "Citizenship required.",
            "Evaluations": "Evaluated on experience.",
            "HowToApply": "Apply through the agency.",
            "WhatToExpectNext": "Agency will contact you.",
            "RequiredDocuments": "Submit transcript.",
            "Benefits": "Benefits depend on appointment.",
            "OtherInformation": "Final source clause.",
        }
    )
    posting = adapter.normalize(adapter._parse_job(item, _company()), _company(), NOW)
    assert "Design flight hardware." in posting.description_text
    assert "Submit transcript." in posting.description_text
    assert "Final source clause." in posting.description_text
    assert posting.description_status == "available"


@pytest.mark.asyncio
async def test_usajobs_missing_results_array_is_failure_not_empty_board() -> None:
    client = await make_mock_client(MockTransport([json_response({"SearchResult": {}})]))
    try:
        with pytest.raises(SourceParseError):
            await USAJobsAdapter().fetch(client, _company(), _company().sources[0])
    finally:
        await client.close()
