from __future__ import annotations

import pytest

from poller.exceptions import SourceParseError
from poller.pagination import PaginationGuard
from poller.sources import get_adapter
from poller.tests.conftest import MockTransport, json_response, make_company, make_mock_client


def test_offset_drift_can_overlap_as_long_as_pagination_makes_progress() -> None:
    guard = PaginationGuard("workday", "example")
    assert not guard.observe(["a", "b"], 4)
    assert not guard.observe(["b", "c"], 0)
    assert guard.observe(["c", "d"], 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [
    "greenhouse", "ashby", "bamboohr", "recruitee", "pinpoint", "teamtailor", "workable",
])
async def test_missing_listing_array_is_a_schema_failure(provider: str) -> None:
    company = make_company(source_type=provider)
    client = await make_mock_client(MockTransport([json_response({"error": "changed schema"})]))
    try:
        with pytest.raises(SourceParseError):
            await get_adapter(provider).fetch(client, company, company.sources[0])
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "field"), [
    ("greenhouse", "jobs"), ("ashby", "jobs"), ("bamboohr", "result"),
    ("recruitee", "offers"), ("pinpoint", "data"), ("teamtailor", "data"),
    ("workable", "jobs"), ("lever", None), ("breezy", None), ("comeet", None),
    ("jazzhr", None), ("simplify", None),
])
async def test_skipped_malformed_record_blocks_absence_closures(
    provider: str, field: str | None,
) -> None:
    record = {"active": True, "is_visible": True} if provider == "simplify" else {}
    payload = {field: [record]} if field else [record]
    company = make_company(source_type=provider)
    client = await make_mock_client(MockTransport([json_response(payload)]))
    adapter = get_adapter(provider)
    try:
        await adapter.fetch(client, company, company.sources[0])
        assert adapter.potentially_truncated
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata", [{"links": {"next": "?page=2"}}, {"meta": {"total": 10}}])
async def test_unhandled_pagination_metadata_blocks_closures(metadata: dict[str, object]) -> None:
    company = make_company(source_type="greenhouse")
    client = await make_mock_client(MockTransport([json_response({"jobs": [], **metadata})]))
    adapter = get_adapter("greenhouse")
    try:
        await adapter.fetch(client, company, company.sources[0])
        assert adapter.potentially_truncated
    finally:
        await client.close()
