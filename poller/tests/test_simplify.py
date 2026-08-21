from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from poller.dedupe import dedupe_postings
from poller.models import Company, Posting, SourceConfig, compute_posting_id
from poller.sources.simplify import (
    SimplifyAdapter,
    generate_registry_candidates,
    infer_ats_from_url,
    slugify_company,
)
from poller.tests.conftest import MockTransport, json_response, make_mock_client

FIXTURES = Path(__file__).parent / "fixtures" / "simplify"
NOW = "2026-08-21T12:00:00Z"


def _load_fixture(name: str) -> list[dict[str, Any]]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _dummy_company() -> Company:
    return Company(
        slug="__simplify__",
        name="Simplify",
        tags=[],
        sources=[SourceConfig(type="simplify", board_token="")],
    )


class TestSlugifyCompany:
    def test_jane_street(self) -> None:
        assert slugify_company("Jane Street") == "jane-street"

    def test_two_sigma(self) -> None:
        assert slugify_company("Two Sigma") == "two-sigma"

    def test_scale_ai(self) -> None:
        assert slugify_company("Scale AI") == "scale-ai"

    def test_trailing_whitespace(self) -> None:
        assert slugify_company("BMO ") == "bmo"

    def test_leading_whitespace(self) -> None:
        assert slugify_company(" Stripe ") == "stripe"

    def test_special_chars(self) -> None:
        assert slugify_company("L3Harris Technologies") == "l3harris-technologies"

    def test_consecutive_special_chars(self) -> None:
        assert slugify_company("Corp && Co.") == "corp-co"

    def test_ampersand(self) -> None:
        assert slugify_company("McKinsey & Company") == "mckinsey-company"

    def test_dots(self) -> None:
        assert slugify_company("D. E. Shaw") == "d-e-shaw"

    def test_empty_after_strip(self) -> None:
        assert slugify_company("   ") == ""

    def test_unicode(self) -> None:
        assert slugify_company("Café Corp") == "caf-corp"


class TestInferAtsFromUrl:
    def test_greenhouse_boards(self) -> None:
        ats, token = infer_ats_from_url(
            "https://boards.greenhouse.io/stripe/jobs/12345"
        )
        assert ats == "greenhouse"
        assert token == "stripe"

    def test_greenhouse_job_boards(self) -> None:
        ats, token = infer_ats_from_url(
            "https://job-boards.greenhouse.io/mcghealth/jobs/8350486"
        )
        assert ats == "greenhouse"
        assert token == "mcghealth"

    def test_lever(self) -> None:
        ats, token = infer_ats_from_url(
            "https://jobs.lever.co/cloudflare/abc-123"
        )
        assert ats == "lever"
        assert token == "cloudflare"

    def test_lever_with_apply_suffix(self) -> None:
        ats, token = infer_ats_from_url(
            "https://jobs.lever.co/voltus/b7833dd8/apply"
        )
        assert ats == "lever"
        assert token == "voltus"

    def test_lever_eu(self) -> None:
        ats, token = infer_ats_from_url(
            "https://jobs.eu.lever.co/wise/abc-456"
        )
        assert ats == "lever"
        assert token == "wise"

    def test_ashby(self) -> None:
        ats, token = infer_ats_from_url(
            "https://jobs.ashbyhq.com/linear/abc-789"
        )
        assert ats == "ashby"
        assert token == "linear"

    def test_ashby_with_application_suffix(self) -> None:
        ats, token = infer_ats_from_url(
            "https://jobs.ashbyhq.com/dryft/3f1c261d/application"
        )
        assert ats == "ashby"
        assert token == "dryft"

    def test_workday(self) -> None:
        ats, token = infer_ats_from_url(
            "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Intern_JR001"
        )
        assert ats == "workday"
        assert token == "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"

    def test_workday_with_locale(self) -> None:
        ats, token = infer_ats_from_url(
            "https://bmo.wd3.myworkdayjobs.com/en-US/Privileged/job/Chicago/Data-Analyst_R250032685"
        )
        assert ats == "workday"
        assert token == "bmo.wd3.myworkdayjobs.com/Privileged"

    def test_smartrecruiters(self) -> None:
        ats, token = infer_ats_from_url(
            "https://jobs.smartrecruiters.com/Visa/sr-777"
        )
        assert ats == "smartrecruiters"
        assert token == "Visa"

    def test_unknown_google(self) -> None:
        ats, token = infer_ats_from_url(
            "https://careers.google.com/jobs/results/123"
        )
        assert ats == "other"
        assert token is None

    def test_unknown_amazon(self) -> None:
        ats, token = infer_ats_from_url(
            "https://amazon.jobs/en/jobs/2345678/sde-intern"
        )
        assert ats == "other"
        assert token is None


class TestSimplifyFetch:
    @pytest.mark.asyncio
    async def test_filters_active_visible(self) -> None:
        fixture = _load_fixture("active_visible_listings.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 60
        await client.close()

    @pytest.mark.asyncio
    async def test_all_postings_from_active_visible(self) -> None:
        fixture = _load_fixture("active_visible_listings.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        for posting in raw:
            assert posting.source == "simplify"
            assert posting.url != ""
            assert posting.company_slug != ""
        await client.close()

    @pytest.mark.asyncio
    async def test_url_is_direct_link_not_simplify(self) -> None:
        fixture = _load_fixture("active_visible_listings.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        for posting in raw:
            assert "simplify.jobs" not in posting.url
        await client.close()

    @pytest.mark.asyncio
    async def test_company_slug_derived_from_name(self) -> None:
        fixture = [
            {
                "source": "Simplify",
                "category": "Software",
                "company_name": "Jane Street",
                "id": "test-id-1",
                "title": "SWE Intern",
                "active": True,
                "terms": ["Summer 2027"],
                "date_updated": 1766592650,
                "date_posted": 1766592650,
                "url": "https://boards.greenhouse.io/janestreet/jobs/1",
                "locations": ["NYC"],
                "company_url": "",
                "is_visible": True,
                "sponsorship": "Other",
                "degrees": [],
            },
            {
                "source": "Simplify",
                "category": "Software",
                "company_name": "Two Sigma ",
                "id": "test-id-2",
                "title": "SWE Intern",
                "active": True,
                "terms": [],
                "date_updated": 1766592650,
                "date_posted": 1766592650,
                "url": "https://boards.greenhouse.io/twosigma/jobs/2",
                "locations": ["NYC"],
                "company_url": "",
                "is_visible": True,
                "sponsorship": "Other",
                "degrees": [],
            },
        ]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert raw[0].company_slug == "jane-street"
        assert raw[1].company_slug == "two-sigma"
        await client.close()

    @pytest.mark.asyncio
    async def test_parse_error_on_non_array(self) -> None:
        transport = MockTransport([json_response({"error": "not an array"})])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        from poller.exceptions import SourceParseError

        with pytest.raises(SourceParseError, match="expected JSON array"):
            await adapter.fetch(client, company, company.sources[0])
        await client.close()

    @pytest.mark.asyncio
    async def test_malformed_listing_skipped(self) -> None:
        fixture = [
            {"active": True, "is_visible": True},
            {
                "source": "Simplify",
                "category": "Software",
                "company_name": "Valid Corp",
                "id": "valid-id",
                "title": "SWE Intern",
                "active": True,
                "terms": [],
                "date_updated": 1766592650,
                "date_posted": 1766592650,
                "url": "https://boards.greenhouse.io/valid/jobs/1",
                "locations": ["NYC"],
                "company_url": "",
                "is_visible": True,
                "sponsorship": "Other",
                "degrees": [],
            },
        ]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert len(raw) == 1
        assert raw[0].company_slug == "valid-corp"
        await client.close()

    @pytest.mark.asyncio
    async def test_posted_at_from_timestamp(self) -> None:
        fixture = [
            {
                "source": "Simplify",
                "category": "Software",
                "company_name": "TimeCorp",
                "id": "time-test",
                "title": "Intern",
                "active": True,
                "terms": [],
                "date_updated": 1672531200,
                "date_posted": 1672531200,
                "url": "https://boards.greenhouse.io/timecorp/jobs/1",
                "locations": [],
                "company_url": "",
                "is_visible": True,
                "sponsorship": "Other",
                "degrees": [],
            },
        ]
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        assert raw[0].posted_at == "2023-01-01T00:00:00Z"
        await client.close()


class TestSimplifyNormalize:
    def _make_raw(
        self,
        url: str = "https://boards.greenhouse.io/stripe/jobs/123",
        sponsorship: str | None = "Offers Sponsorship",
        terms: list[str] | None = None,
        degrees: list[str] | None = None,
        category: str = "Software Engineering",
    ) -> Any:
        from poller.models import RawPosting

        return RawPosting(
            source="simplify",
            company_slug="stripe",
            source_job_id="test-job-id",
            title="Software Engineering Intern",
            location="New York, NY",
            locations=["New York, NY"],
            url=url,
            posted_at="2026-08-01T00:00:00Z",
            description="",
            raw_data={
                "company_name": "Stripe",
                "sponsorship": sponsorship,
                "terms": terms if terms is not None else ["Summer 2027"],
                "degrees": degrees if degrees is not None else ["Bachelor's"],
                "category": category,
            },
        )

    def test_produces_valid_posting(self) -> None:
        adapter = SimplifyAdapter()
        raw = self._make_raw()
        company = _dummy_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.source == "simplify"
        assert posting.company == "Stripe"
        assert posting.company_slug == "stripe"
        assert posting.first_seen_at == NOW
        assert posting.last_seen_at == NOW
        assert len(posting.id) == 16
        assert all(c in "0123456789abcdef" for c in posting.id)

    def test_ats_inferred_from_url(self) -> None:
        adapter = SimplifyAdapter()
        company = _dummy_company()

        cases = [
            ("https://boards.greenhouse.io/x/jobs/1", "greenhouse"),
            ("https://jobs.lever.co/x/1", "lever"),
            ("https://jobs.ashbyhq.com/x/1", "ashby"),
            ("https://nvidia.wd5.myworkdayjobs.com/Site/job/1", "workday"),
            ("https://jobs.smartrecruiters.com/X/1", "smartrecruiters"),
            ("https://careers.google.com/jobs/1", "other"),
        ]
        for url, expected_ats in cases:
            raw = self._make_raw(url=url)
            posting = adapter.normalize(raw, company, NOW)
            assert posting.ats == expected_ats, (
                f"URL {url} -> expected {expected_ats}, got {posting.ats}"
            )

    def test_source_metadata_populated(self) -> None:
        adapter = SimplifyAdapter()
        raw = self._make_raw(
            sponsorship="Offers Sponsorship",
            terms=["Summer 2027"],
            degrees=["Bachelor's"],
            category="Software Engineering",
        )
        company = _dummy_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.source_metadata is not None
        assert posting.source_metadata["sponsorship"] == "Offers Sponsorship"
        assert posting.source_metadata["terms"] == ["Summer 2027"]
        assert posting.source_metadata["degrees"] == ["Bachelor's"]
        assert posting.source_metadata["category"] == "Software Engineering"

    def test_source_metadata_none_when_empty(self) -> None:
        adapter = SimplifyAdapter()
        raw = self._make_raw(
            sponsorship=None, terms=[], degrees=[], category="",
        )
        company = _dummy_company()

        posting = adapter.normalize(raw, company, NOW)

        assert posting.source_metadata is None

    def test_posting_id_deterministic(self) -> None:
        adapter = SimplifyAdapter()
        raw = self._make_raw()
        company = _dummy_company()

        posting1 = adapter.normalize(raw, company, NOW)
        posting2 = adapter.normalize(raw, company, NOW)

        assert posting1.id == posting2.id

    def test_posting_id_uses_simplify_source(self) -> None:
        adapter = SimplifyAdapter()
        raw = self._make_raw()
        company = _dummy_company()

        posting = adapter.normalize(raw, company, NOW)

        expected_id = compute_posting_id("simplify", "stripe", "test-job-id")
        assert posting.id == expected_id


class TestSponsorshipMetadata:
    @pytest.mark.asyncio
    async def test_offers_sponsorship(self) -> None:
        fixture = _load_fixture("rich_metadata.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        sponsyes = [r for r in raw if r.company_slug == "sponsyes-corp"]
        assert len(sponsyes) == 1
        posting = adapter.normalize(sponsyes[0], company, NOW)
        assert posting.source_metadata is not None
        assert posting.source_metadata["sponsorship"] == "Offers Sponsorship"
        await client.close()

    @pytest.mark.asyncio
    async def test_does_not_offer_sponsorship(self) -> None:
        fixture = _load_fixture("rich_metadata.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        sponsno = [r for r in raw if r.company_slug == "sponsno-corp"]
        assert len(sponsno) == 1
        posting = adapter.normalize(sponsno[0], company, NOW)
        assert posting.source_metadata is not None
        assert posting.source_metadata["sponsorship"] == "Does Not Offer Sponsorship"
        await client.close()

    @pytest.mark.asyncio
    async def test_citizenship_required(self) -> None:
        fixture = _load_fixture("rich_metadata.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        citizenship = [r for r in raw if r.company_slug == "citizenship-corp"]
        assert len(citizenship) == 1
        posting = adapter.normalize(citizenship[0], company, NOW)
        assert posting.source_metadata is not None
        assert posting.source_metadata["sponsorship"] == "U.S. Citizenship is Required"
        await client.close()

    @pytest.mark.asyncio
    async def test_multiple_terms_and_degrees(self) -> None:
        fixture = _load_fixture("rich_metadata.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw = await adapter.fetch(client, company, company.sources[0])

        multiterm = [r for r in raw if r.company_slug == "multiterm-corp"]
        assert len(multiterm) == 1
        posting = adapter.normalize(multiterm[0], company, NOW)
        assert posting.source_metadata is not None
        assert posting.source_metadata["terms"] == [
            "Spring 2027", "Summer 2027", "Fall 2027",
        ]
        assert posting.source_metadata["degrees"] == [
            "Bachelor's", "Master's", "PhD",
        ]
        await client.close()


class TestRegistryCandidates:
    def test_excludes_known_companies(self, tmp_path: Path) -> None:
        postings = [
            Posting(
                id="aaa", company="Stripe", company_slug="stripe",
                title="SWE Intern", location="NYC", locations=["NYC"],
                url="https://boards.greenhouse.io/stripe/jobs/1",
                source="simplify", source_job_id="1", ats="greenhouse",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
            Posting(
                id="bbb", company="NewCo", company_slug="newco",
                title="SWE Intern", location="SF", locations=["SF"],
                url="https://boards.greenhouse.io/newco/jobs/2",
                source="simplify", source_job_id="2", ats="greenhouse",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
        ]
        known_slugs = {"stripe"}
        output = tmp_path / "candidates.json"

        generate_registry_candidates(postings, known_slugs, output)

        candidates = json.loads(output.read_text())
        slugs = [c["slug"] for c in candidates]
        assert "stripe" not in slugs
        assert "newco" in slugs

    def test_includes_unknown_with_identifiable_ats(self, tmp_path: Path) -> None:
        postings = [
            Posting(
                id="aaa", company="GH Corp", company_slug="gh-corp",
                title="Intern", location="NYC", locations=["NYC"],
                url="https://boards.greenhouse.io/ghcorp/jobs/1",
                source="simplify", source_job_id="1", ats="greenhouse",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
            Posting(
                id="bbb", company="LV Corp", company_slug="lv-corp",
                title="Intern", location="SF", locations=["SF"],
                url="https://jobs.lever.co/lvcorp/abc",
                source="simplify", source_job_id="2", ats="lever",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
        ]
        output = tmp_path / "candidates.json"

        generate_registry_candidates(postings, set(), output)

        candidates = json.loads(output.read_text())
        assert len(candidates) == 2
        assert candidates[0]["inferred_ats"] == "greenhouse"
        assert candidates[0]["inferred_board_token"] == "ghcorp"
        assert candidates[1]["inferred_ats"] == "lever"
        assert candidates[1]["inferred_board_token"] == "lvcorp"

    def test_excludes_unknown_ats(self, tmp_path: Path) -> None:
        postings = [
            Posting(
                id="aaa", company="Google", company_slug="google",
                title="Intern", location="MTV", locations=["MTV"],
                url="https://careers.google.com/jobs/1",
                source="simplify", source_job_id="1", ats="other",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
        ]
        output = tmp_path / "candidates.json"

        generate_registry_candidates(postings, set(), output)

        candidates = json.loads(output.read_text())
        assert len(candidates) == 0

    def test_posting_count_correct(self, tmp_path: Path) -> None:
        postings = [
            Posting(
                id=f"id{i}", company="NewCo", company_slug="newco",
                title=f"Intern {i}", location="NYC", locations=["NYC"],
                url=f"https://boards.greenhouse.io/newco/jobs/{i}",
                source="simplify", source_job_id=str(i), ats="greenhouse",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            )
            for i in range(5)
        ]
        output = tmp_path / "candidates.json"

        generate_registry_candidates(postings, set(), output)

        candidates = json.loads(output.read_text())
        assert len(candidates) == 1
        assert candidates[0]["posting_count"] == 5

    def test_skips_non_simplify_postings(self, tmp_path: Path) -> None:
        postings = [
            Posting(
                id="aaa", company="Stripe", company_slug="stripe",
                title="Intern", location="NYC", locations=["NYC"],
                url="https://boards.greenhouse.io/stripe/jobs/1",
                source="greenhouse", source_job_id="1", ats="greenhouse",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
        ]
        output = tmp_path / "candidates.json"

        generate_registry_candidates(postings, set(), output)

        candidates = json.loads(output.read_text())
        assert len(candidates) == 0

    def test_output_format(self, tmp_path: Path) -> None:
        postings = [
            Posting(
                id="aaa", company="NewCo", company_slug="newco",
                title="Intern", location="NYC", locations=["NYC"],
                url="https://boards.greenhouse.io/newco/jobs/1",
                source="simplify", source_job_id="1", ats="greenhouse",
                posted_at=None, first_seen_at=NOW, last_seen_at=NOW,
            ),
        ]
        output = tmp_path / "candidates.json"

        generate_registry_candidates(postings, set(), output)

        candidates = json.loads(output.read_text())
        c = candidates[0]
        assert "slug" in c
        assert "name" in c
        assert "inferred_ats" in c
        assert "inferred_board_token" in c
        assert "apply_url" in c
        assert "posting_count" in c


class TestDedupIntegration:
    def test_greenhouse_beats_simplify(self) -> None:
        greenhouse_posting = Posting(
            id=compute_posting_id("greenhouse", "watershed", "6216631003"),
            company="Watershed",
            company_slug="watershed",
            title="Customer Success Engineer, Bioinformatics",
            location="Cambridge, MA",
            locations=["Cambridge, MA"],
            url="https://boards.greenhouse.io/watershed/jobs/6216631003",
            source="greenhouse",
            source_job_id="6216631003",
            ats="greenhouse",
            posted_at="2024-09-23T16:50:04Z",
            first_seen_at="2026-08-01T00:00:00Z",
            last_seen_at=NOW,
        )

        simplify_posting = Posting(
            id=compute_posting_id("simplify", "watershed", "simplify-uuid-1"),
            company="Watershed",
            company_slug="watershed",
            title="Customer Success Engineer, Bioinformatics",
            location="Cambridge, MA",
            locations=["Cambridge, MA"],
            url="https://boards.greenhouse.io/watershed/jobs/6216631003",
            source="simplify",
            source_job_id="simplify-uuid-1",
            ats="greenhouse",
            posted_at="2026-06-01T00:00:00Z",
            first_seen_at="2026-06-01T00:00:00Z",
            last_seen_at=NOW,
        )

        result = dedupe_postings([greenhouse_posting, simplify_posting])

        assert len(result) == 1
        canonical = result[0]
        assert canonical.source == "greenhouse"
        assert canonical.id == greenhouse_posting.id
        assert simplify_posting.id in canonical.merged_from
        assert canonical.first_seen_at == "2026-06-01T00:00:00Z"

    def test_different_company_not_deduped(self) -> None:
        posting_a = Posting(
            id=compute_posting_id("greenhouse", "company-a", "1"),
            company="Company A",
            company_slug="company-a",
            title="Software Engineering Intern",
            location="NYC",
            locations=["NYC"],
            url="https://boards.greenhouse.io/a/jobs/1",
            source="greenhouse",
            source_job_id="1",
            ats="greenhouse",
            posted_at=None,
            first_seen_at=NOW,
            last_seen_at=NOW,
        )

        posting_b = Posting(
            id=compute_posting_id("simplify", "company-b", "2"),
            company="Company B",
            company_slug="company-b",
            title="Software Engineering Intern",
            location="NYC",
            locations=["NYC"],
            url="https://boards.greenhouse.io/b/jobs/2",
            source="simplify",
            source_job_id="2",
            ats="greenhouse",
            posted_at=None,
            first_seen_at=NOW,
            last_seen_at=NOW,
        )

        result = dedupe_postings([posting_a, posting_b])

        assert len(result) == 2

    def test_different_title_not_deduped(self) -> None:
        posting_a = Posting(
            id=compute_posting_id("greenhouse", "acme", "1"),
            company="Acme",
            company_slug="acme",
            title="Backend Engineer",
            location="NYC",
            locations=["NYC"],
            url="https://boards.greenhouse.io/acme/jobs/1",
            source="greenhouse",
            source_job_id="1",
            ats="greenhouse",
            posted_at=None,
            first_seen_at=NOW,
            last_seen_at=NOW,
        )

        posting_b = Posting(
            id=compute_posting_id("simplify", "acme", "2"),
            company="Acme",
            company_slug="acme",
            title="Frontend Engineer",
            location="NYC",
            locations=["NYC"],
            url="https://boards.greenhouse.io/acme/jobs/2",
            source="simplify",
            source_job_id="2",
            ats="greenhouse",
            posted_at=None,
            first_seen_at=NOW,
            last_seen_at=NOW,
        )

        result = dedupe_postings([posting_a, posting_b])

        assert len(result) == 2


class TestFullNormalizePipeline:
    @pytest.mark.asyncio
    async def test_rich_metadata_round_trip(self) -> None:
        fixture = _load_fixture("rich_metadata.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw_postings = await adapter.fetch(client, company, company.sources[0])
        postings = [adapter.normalize(raw, company, NOW) for raw in raw_postings]

        assert len(postings) == 15
        for p in postings:
            assert p.source == "simplify"
            assert len(p.id) == 16
            assert p.first_seen_at == NOW
            assert "simplify.jobs" not in p.url

        sponsorship_postings = [
            p for p in postings
            if p.source_metadata and "sponsorship" in p.source_metadata
        ]
        assert len(sponsorship_postings) >= 4

        ats_types = {p.ats for p in postings}
        assert "greenhouse" in ats_types
        assert "lever" in ats_types
        assert "ashby" in ats_types
        assert "workday" in ats_types
        await client.close()

    @pytest.mark.asyncio
    async def test_active_visible_fixture_all_normalized(self) -> None:
        fixture = _load_fixture("active_visible_listings.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw_postings = await adapter.fetch(client, company, company.sources[0])
        postings = [adapter.normalize(raw, company, NOW) for raw in raw_postings]

        assert len(postings) == 60
        for p in postings:
            assert p.id
            assert p.company
            assert p.company_slug
            assert p.title
            assert p.url
            assert p.source == "simplify"
            assert p.ats in {
                "greenhouse", "lever", "ashby", "workday",
                "smartrecruiters", "other",
            }
        await client.close()

    @pytest.mark.asyncio
    async def test_empty_locations_handled(self) -> None:
        fixture = _load_fixture("rich_metadata.json")
        transport = MockTransport([json_response(fixture)])
        client = await make_mock_client(transport)
        adapter = SimplifyAdapter()
        company = _dummy_company()

        raw_postings = await adapter.fetch(client, company, company.sources[0])
        remote_corp = [r for r in raw_postings if r.company_slug == "remote-corp"]
        assert len(remote_corp) == 1
        assert remote_corp[0].location == ""
        assert remote_corp[0].locations == []

        posting = adapter.normalize(remote_corp[0], company, NOW)
        assert posting.location == ""
        assert posting.locations == []
        await client.close()
