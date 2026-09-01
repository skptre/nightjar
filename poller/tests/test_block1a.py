"""Block 1A tests: first-party adapter stubs, source type registration, inventory schema."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from poller.dedupe import SOURCE_PRIORITY
from poller.exceptions import SourceFetchError
from poller.models import RawPosting, compute_posting_id
from poller.registry import VALID_SOURCE_TYPES
from poller.sources import ADAPTERS, get_adapter
from poller.sources.google_careers import ADAPTER_STATUS as GOOGLE_STATUS
from poller.sources.google_careers import GoogleCareersAdapter
from poller.sources.microsoft_careers import ADAPTER_STATUS as MSFT_STATUS
from poller.sources.microsoft_careers import MicrosoftCareersAdapter
from poller.tests.conftest import make_company

NOW = "2026-09-01T20:00:00Z"

INVENTORY_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "data"
    / "first_party_candidates.json"
)


# --- Source type registration ---


class TestSourceTypeRegistration:
    def test_google_careers_in_valid_source_types(self) -> None:
        assert "google_careers" in VALID_SOURCE_TYPES

    def test_microsoft_careers_in_valid_source_types(self) -> None:
        assert "microsoft_careers" in VALID_SOURCE_TYPES

    def test_google_careers_in_source_priority(self) -> None:
        assert "google_careers" in SOURCE_PRIORITY
        assert SOURCE_PRIORITY["google_careers"] == 2

    def test_microsoft_careers_in_source_priority(self) -> None:
        assert "microsoft_careers" in SOURCE_PRIORITY
        assert SOURCE_PRIORITY["microsoft_careers"] == 2

    def test_google_careers_in_adapters_dict(self) -> None:
        assert "google_careers" in ADAPTERS
        assert ADAPTERS["google_careers"] is GoogleCareersAdapter

    def test_microsoft_careers_in_adapters_dict(self) -> None:
        assert "microsoft_careers" in ADAPTERS
        assert ADAPTERS["microsoft_careers"] is MicrosoftCareersAdapter

    def test_get_adapter_returns_google_instance(self) -> None:
        adapter = get_adapter("google_careers")
        assert isinstance(adapter, GoogleCareersAdapter)

    def test_get_adapter_returns_microsoft_instance(self) -> None:
        adapter = get_adapter("microsoft_careers")
        assert isinstance(adapter, MicrosoftCareersAdapter)

    def test_all_valid_source_types_have_adapters(self) -> None:
        for source_type in VALID_SOURCE_TYPES:
            assert source_type in ADAPTERS, (
                f"{source_type} in VALID_SOURCE_TYPES but not ADAPTERS"
            )

    def test_all_adapters_have_valid_source_types(self) -> None:
        for source_type in ADAPTERS:
            assert source_type in VALID_SOURCE_TYPES, (
                f"{source_type} in ADAPTERS but not VALID_SOURCE_TYPES"
            )

    def test_all_valid_source_types_have_priority(self) -> None:
        for source_type in VALID_SOURCE_TYPES:
            if source_type == "simplify":
                continue
            assert source_type in SOURCE_PRIORITY, f"{source_type} missing from SOURCE_PRIORITY"

    def test_first_party_adapters_higher_priority_than_workday(self) -> None:
        assert SOURCE_PRIORITY["google_careers"] < SOURCE_PRIORITY["workday"]
        assert SOURCE_PRIORITY["microsoft_careers"] < SOURCE_PRIORITY["workday"]


# --- Google Careers adapter ---


class TestGoogleCareersAdapter:
    def test_adapter_status_is_unsupported(self) -> None:
        assert GOOGLE_STATUS == "unsupported_spa"

    @pytest.mark.asyncio
    async def test_fetch_raises_source_fetch_error(self) -> None:
        adapter = GoogleCareersAdapter()
        company = make_company(
            slug="google",
            name="Google",
            source_type="google_careers",
            board_token="google",
        )
        source = company.sources[0]

        with pytest.raises(SourceFetchError, match="JavaScript SPA"):
            await adapter.fetch(None, company, source)  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_fetch_error_contains_company_slug(self) -> None:
        adapter = GoogleCareersAdapter()
        company = make_company(
            slug="google",
            name="Google",
            source_type="google_careers",
            board_token="google",
        )
        source = company.sources[0]

        with pytest.raises(SourceFetchError) as exc_info:
            await adapter.fetch(None, company, source)  # type: ignore[arg-type]
        assert exc_info.value.company_slug == "google"
        assert exc_info.value.source == "google_careers"

    def test_normalize_produces_valid_posting(self) -> None:
        adapter = GoogleCareersAdapter()
        company = make_company(
            slug="google",
            name="Google",
            source_type="google_careers",
            board_token="google",
        )
        raw = RawPosting(
            source="google_careers",
            company_slug="google",
            source_job_id="12345678901234",
            title="Software Engineering Intern, Summer 2027",
            location="Mountain View, CA",
            locations=["Mountain View, CA", "New York, NY"],
            url="https://www.google.com/about/careers/applications/jobs/results/12345678901234",
            posted_at="2026-08-15T00:00:00Z",
            description="Build products used by billions.",
            employment_type="intern",
            department="Engineering",
        )

        posting = adapter.normalize(raw, company, NOW)

        assert posting.id == compute_posting_id("google_careers", "google", "12345678901234")
        assert len(posting.id) == 16
        assert posting.company == "Google"
        assert posting.company_slug == "google"
        assert posting.source == "google_careers"
        assert posting.ats == "google_careers"
        assert posting.title == "Software Engineering Intern, Summer 2027"
        assert posting.location == "Mountain View, CA"
        assert len(posting.locations) == 2
        assert posting.employment_type == "intern"
        assert posting.department == "Engineering"

    def test_normalize_posting_id_deterministic(self) -> None:
        adapter = GoogleCareersAdapter()
        company = make_company(
            slug="google", name="Google",
            source_type="google_careers", board_token="google",
        )
        raw = RawPosting(
            source="google_careers", company_slug="google", source_job_id="99999",
            title="Test", location="", locations=[], url="https://example.com",
            posted_at=None, description="",
        )
        p1 = adapter.normalize(raw, company, NOW)
        p2 = adapter.normalize(raw, company, NOW)
        assert p1.id == p2.id


# --- Microsoft Careers adapter ---


class TestMicrosoftCareersAdapter:
    def test_adapter_status_is_unsupported(self) -> None:
        assert MSFT_STATUS == "unsupported_spa"

    @pytest.mark.asyncio
    async def test_fetch_raises_source_fetch_error(self) -> None:
        adapter = MicrosoftCareersAdapter()
        company = make_company(
            slug="microsoft",
            name="Microsoft",
            source_type="microsoft_careers",
            board_token="microsoft",
        )
        source = company.sources[0]

        with pytest.raises(SourceFetchError, match="JavaScript SPA"):
            await adapter.fetch(None, company, source)  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_fetch_error_contains_company_slug(self) -> None:
        adapter = MicrosoftCareersAdapter()
        company = make_company(
            slug="microsoft",
            name="Microsoft",
            source_type="microsoft_careers",
            board_token="microsoft",
        )
        source = company.sources[0]

        with pytest.raises(SourceFetchError) as exc_info:
            await adapter.fetch(None, company, source)  # type: ignore[arg-type]
        assert exc_info.value.company_slug == "microsoft"
        assert exc_info.value.source == "microsoft_careers"

    def test_normalize_produces_valid_posting(self) -> None:
        adapter = MicrosoftCareersAdapter()
        company = make_company(
            slug="microsoft",
            name="Microsoft",
            source_type="microsoft_careers",
            board_token="microsoft",
        )
        raw = RawPosting(
            source="microsoft_careers",
            company_slug="microsoft",
            source_job_id="1753570",
            title="Software Engineering Intern",
            location="Redmond, WA",
            locations=["Redmond, WA"],
            url="https://apply.careers.microsoft.com/us/en/job/1753570",
            posted_at="2026-08-20T00:00:00Z",
            description="Work on Azure.",
            employment_type="intern",
            department="Cloud + AI",
            workplace_type="hybrid",
        )

        posting = adapter.normalize(raw, company, NOW)

        assert posting.id == compute_posting_id("microsoft_careers", "microsoft", "1753570")
        assert len(posting.id) == 16
        assert posting.company == "Microsoft"
        assert posting.source == "microsoft_careers"
        assert posting.ats == "microsoft_careers"
        assert posting.employment_type == "intern"
        assert posting.department == "Cloud + AI"
        assert posting.workplace_type == "hybrid"


# --- First-party inventory schema ---


class TestFirstPartyInventory:
    def test_inventory_file_exists(self) -> None:
        assert INVENTORY_PATH.exists(), f"Missing {INVENTORY_PATH}"

    def test_inventory_is_valid_json(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        assert isinstance(data, dict)

    def test_inventory_has_candidates_list(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        assert "candidates" in data
        assert isinstance(data["candidates"], list)
        assert len(data["candidates"]) > 0

    def test_inventory_has_verification_statuses(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        assert "verification_statuses" in data
        statuses = data["verification_statuses"]
        assert "pending" in statuses
        assert "verified" in statuses
        assert "unsupported_spa" in statuses

    def test_candidate_schema(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        required_fields = {
            "company_slug", "company_name", "careers_url",
            "observed_backend", "verification_status",
        }
        for candidate in data["candidates"]:
            missing = required_fields - set(candidate.keys())
            slug = candidate.get("company_slug", "?")
            assert not missing, f"{slug} missing: {missing}"

    def test_google_marked_unsupported_spa(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        google = next((c for c in data["candidates"] if c["company_slug"] == "google"), None)
        assert google is not None, "Google missing from inventory"
        assert google["verification_status"] == "unsupported_spa"

    def test_microsoft_marked_unsupported_spa(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        msft = next((c for c in data["candidates"] if c["company_slug"] == "microsoft"), None)
        assert msft is not None, "Microsoft missing from inventory"
        assert msft["verification_status"] == "unsupported_spa"

    def test_no_duplicate_slugs(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        slugs = [c["company_slug"] for c in data["candidates"]]
        dupes = [s for s in slugs if slugs.count(s) > 1]
        assert len(slugs) == len(set(slugs)), f"Dupes: {dupes}"

    def test_all_verification_statuses_are_known(self) -> None:
        data = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        known = set(data["verification_statuses"].keys())
        for candidate in data["candidates"]:
            status = candidate["verification_status"]
            assert status in known, f"{candidate['company_slug']} has unknown status: {status}"
