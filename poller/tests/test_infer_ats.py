from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from poller.tools.infer_ats import (
    enrich_with_titles,
    infer_ats_detailed,
    load_candidates,
    run,
)

if TYPE_CHECKING:
    from pathlib import Path


class TestInferATSDetailed:
    def test_greenhouse_url(self) -> None:
        result = infer_ats_detailed(
            "https://boards.greenhouse.io/ramp/jobs/12345",
        )
        assert result.ats_type == "greenhouse"
        assert result.board_token == "ramp"
        assert result.eu is False

    def test_greenhouse_job_boards_variant(self) -> None:
        result = infer_ats_detailed(
            "https://job-boards.greenhouse.io/stripe/jobs/67890",
        )
        assert result.ats_type == "greenhouse"
        assert result.board_token == "stripe"

    def test_lever_url(self) -> None:
        result = infer_ats_detailed(
            "https://jobs.lever.co/cloudflare/abc-123",
        )
        assert result.ats_type == "lever"
        assert result.board_token == "cloudflare"
        assert result.eu is False

    def test_lever_eu_url(self) -> None:
        result = infer_ats_detailed(
            "https://jobs.eu.lever.co/company/abc-456",
        )
        assert result.ats_type == "lever"
        assert result.board_token == "company"
        assert result.eu is True

    def test_ashby_url(self) -> None:
        result = infer_ats_detailed(
            "https://jobs.ashbyhq.com/linear/abc-789",
        )
        assert result.ats_type == "ashby"
        assert result.board_token == "linear"
        assert result.eu is False

    def test_workday_url_with_locale(self) -> None:
        result = infer_ats_detailed(
            "https://nvidia.wd5.myworkdayjobs.com/en-US"
            "/NVIDIAExternalCareerSite/job/abc",
        )
        assert result.ats_type == "workday"
        assert (
            result.board_token
            == "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
        )

    def test_workday_url_without_locale(self) -> None:
        result = infer_ats_detailed(
            "https://nvidia.wd5.myworkdayjobs.com"
            "/NVIDIAExternalCareerSite/job/Details/123",
        )
        assert result.ats_type == "workday"
        assert (
            result.board_token
            == "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
        )

    def test_workday_different_datacenter(self) -> None:
        result = infer_ats_detailed(
            "https://intel.wd1.myworkdayjobs.com/en-US/External/job/SWE-Intern",
        )
        assert result.ats_type == "workday"
        assert result.board_token == "intel.wd1.myworkdayjobs.com/External"

    def test_smartrecruiters_url(self) -> None:
        result = infer_ats_detailed(
            "https://jobs.smartrecruiters.com/Visa/abc-123",
        )
        assert result.ats_type == "smartrecruiters"
        assert result.board_token == "Visa"

    def test_unknown_url(self) -> None:
        result = infer_ats_detailed(
            "https://careers.google.com/jobs/123",
        )
        assert result.ats_type is None
        assert result.board_token is None
        assert result.eu is False

    def test_unknown_custom_careers_page(self) -> None:
        result = infer_ats_detailed(
            "https://www.apple.com/careers/us/students.html",
        )
        assert result.ats_type is None
        assert result.board_token is None

    def test_empty_url(self) -> None:
        result = infer_ats_detailed("")
        assert result.ats_type is None
        assert result.board_token is None


class TestLoadCandidates:
    def test_load_existing_file(self, tmp_path: Path) -> None:
        candidates = [
            {"slug": "acme", "name": "Acme", "inferred_ats": "greenhouse"},
        ]
        path = tmp_path / "candidates.json"
        path.write_text(json.dumps(candidates), encoding="utf-8")

        result = load_candidates(path)
        assert len(result) == 1
        assert result[0]["slug"] == "acme"

    def test_load_missing_file(self, tmp_path: Path) -> None:
        path = tmp_path / "nonexistent.json"
        result = load_candidates(path)
        assert result == []


class TestEnrichWithTitles:
    def _make_feed(
        self,
        path: Path,
        postings: dict[str, dict[str, Any]],
    ) -> None:
        feed = {
            "updated_at": "2026-08-21T12:00:00Z",
            "version": 1,
            "count": len(postings),
            "postings": postings,
        }
        path.write_text(json.dumps(feed), encoding="utf-8")

    def test_titles_populated_from_feed(self, tmp_path: Path) -> None:
        feed_path = tmp_path / "feed.json"
        self._make_feed(feed_path, {
            "p1": {
                "source": "simplify",
                "company_slug": "acme",
                "title": "SWE Intern",
            },
            "p2": {
                "source": "simplify",
                "company_slug": "acme",
                "title": "ML Intern",
            },
            "p3": {
                "source": "greenhouse",
                "company_slug": "acme",
                "title": "Backend Intern",
            },
        })

        candidates: list[dict[str, Any]] = [
            {"slug": "acme", "name": "Acme"},
        ]
        enrich_with_titles(candidates, feed_path)

        assert candidates[0]["titles"] == ["ML Intern", "SWE Intern"]
        assert candidates[0]["posting_count"] == 2

    def test_no_feed_file(self, tmp_path: Path) -> None:
        feed_path = tmp_path / "feed.json"
        candidates: list[dict[str, Any]] = [
            {"slug": "acme", "name": "Acme"},
        ]
        enrich_with_titles(candidates, feed_path)
        assert "titles" not in candidates[0]

    def test_company_not_in_feed(self, tmp_path: Path) -> None:
        feed_path = tmp_path / "feed.json"
        self._make_feed(feed_path, {
            "p1": {
                "source": "simplify",
                "company_slug": "other-co",
                "title": "SWE Intern",
            },
        })

        candidates: list[dict[str, Any]] = [
            {"slug": "acme", "name": "Acme"},
        ]
        enrich_with_titles(candidates, feed_path)

        assert candidates[0]["titles"] == []
        assert candidates[0]["posting_count"] == 0

    def test_deduplicates_titles(self, tmp_path: Path) -> None:
        feed_path = tmp_path / "feed.json"
        self._make_feed(feed_path, {
            "p1": {
                "source": "simplify",
                "company_slug": "acme",
                "title": "SWE Intern",
            },
            "p2": {
                "source": "simplify",
                "company_slug": "acme",
                "title": "SWE Intern",
            },
        })

        candidates: list[dict[str, Any]] = [
            {"slug": "acme", "name": "Acme"},
        ]
        enrich_with_titles(candidates, feed_path)

        assert candidates[0]["titles"] == ["SWE Intern"]


class TestRegistryDedup:
    def _write_registry(
        self, path: Path, slugs: list[str],
    ) -> None:
        entries = [
            {
                "slug": slug,
                "name": slug.title(),
                "sources": [
                    {"type": "greenhouse", "board_token": slug},
                ],
            }
            for slug in slugs
        ]
        path.write_text(
            __import__("yaml").dump(entries),
            encoding="utf-8",
        )

    def _write_candidates(
        self,
        path: Path,
        candidates: list[dict[str, Any]],
    ) -> None:
        path.write_text(
            json.dumps(candidates, indent=2) + "\n",
            encoding="utf-8",
        )

    @pytest.mark.asyncio()
    async def test_skip_existing_registry_companies(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, ["existing-co"])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "existing-co",
                "name": "Existing Co",
                "inferred_ats": "greenhouse",
                "inferred_board_token": "existingco",
                "apply_url": "https://boards.greenhouse.io/existingco/jobs/1",
                "posting_count": 3,
            },
            {
                "slug": "new-co",
                "name": "New Co",
                "inferred_ats": "lever",
                "inferred_board_token": "newco",
                "apply_url": "https://jobs.lever.co/newco/abc",
                "posting_count": 2,
            },
        ])

        result = await run(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert len(result) == 1
        assert result[0]["slug"] == "new-co"


class TestFullPipeline:
    def _write_candidates(
        self,
        path: Path,
        candidates: list[dict[str, Any]],
    ) -> None:
        path.write_text(
            json.dumps(candidates, indent=2) + "\n",
            encoding="utf-8",
        )

    def _write_feed(
        self,
        path: Path,
        postings: dict[str, dict[str, Any]],
    ) -> None:
        feed = {
            "updated_at": "2026-08-21T12:00:00Z",
            "version": 1,
            "count": len(postings),
            "postings": postings,
        }
        path.write_text(json.dumps(feed), encoding="utf-8")

    def _write_registry(self, path: Path, slugs: list[str]) -> None:
        entries = [
            {
                "slug": slug,
                "name": slug.title(),
                "sources": [
                    {"type": "greenhouse", "board_token": slug},
                ],
            }
            for slug in slugs
        ]
        path.write_text(
            __import__("yaml").dump(entries),
            encoding="utf-8",
        )

    @pytest.mark.asyncio()
    async def test_full_enrichment_pipeline(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, ["already-known"])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "already-known",
                "name": "Already Known",
                "inferred_ats": "greenhouse",
                "inferred_board_token": "alreadyknown",
                "apply_url": "https://boards.greenhouse.io/alreadyknown/jobs/1",
                "posting_count": 1,
            },
            {
                "slug": "new-greenhouse",
                "name": "New Greenhouse",
                "inferred_ats": "greenhouse",
                "inferred_board_token": "newgreenhouse",
                "apply_url": "https://boards.greenhouse.io/newgreenhouse/jobs/2",
                "posting_count": 2,
            },
            {
                "slug": "new-lever-eu",
                "name": "New Lever EU",
                "inferred_ats": "lever",
                "inferred_board_token": "newlevereu",
                "apply_url": "https://jobs.eu.lever.co/newlevereu/abc",
                "posting_count": 1,
            },
        ])

        self._write_feed(data_dir / "feed.json", {
            "p1": {
                "source": "simplify",
                "company_slug": "new-greenhouse",
                "title": "Frontend Intern",
            },
            "p2": {
                "source": "simplify",
                "company_slug": "new-greenhouse",
                "title": "Backend Intern",
            },
            "p3": {
                "source": "simplify",
                "company_slug": "new-lever-eu",
                "title": "Data Scientist",
            },
        })

        result = await run(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert len(result) == 2

        greenhouse_entry = next(
            c for c in result if c["slug"] == "new-greenhouse"
        )
        assert greenhouse_entry["inferred_ats"] == "greenhouse"
        assert greenhouse_entry["inferred_board_token"] == "newgreenhouse"
        assert "eu" not in greenhouse_entry
        assert greenhouse_entry["titles"] == [
            "Backend Intern",
            "Frontend Intern",
        ]
        assert greenhouse_entry["posting_count"] == 2

        lever_entry = next(
            c for c in result if c["slug"] == "new-lever-eu"
        )
        assert lever_entry["inferred_ats"] == "lever"
        assert lever_entry["inferred_board_token"] == "newlevereu"
        assert lever_entry["eu"] is True
        assert lever_entry["titles"] == ["Data Scientist"]

    @pytest.mark.asyncio()
    async def test_output_written_to_disk(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, [])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "test-co",
                "name": "Test Co",
                "inferred_ats": "ashby",
                "inferred_board_token": "testco",
                "apply_url": "https://jobs.ashbyhq.com/testco/job1",
                "posting_count": 1,
            },
        ])

        await run(data_dir=data_dir, registry_path=registry_path)

        output_path = data_dir / "registry_candidates.json"
        assert output_path.exists()
        output = json.loads(output_path.read_text(encoding="utf-8"))
        assert len(output) == 1
        assert output[0]["slug"] == "test-co"
        assert output[0]["inferred_ats"] == "ashby"

    @pytest.mark.asyncio()
    async def test_empty_candidates_file(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        self._write_candidates(
            data_dir / "registry_candidates.json", [],
        )

        result = await run(data_dir=data_dir)
        assert result == []

    @pytest.mark.asyncio()
    async def test_no_candidates_file(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        result = await run(data_dir=data_dir)
        assert result == []

    @pytest.mark.asyncio()
    async def test_lever_eu_flag_removed_on_non_eu(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, [])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "stale-eu",
                "name": "Stale EU",
                "inferred_ats": "lever",
                "inferred_board_token": "staleeu",
                "apply_url": "https://jobs.lever.co/staleeu/abc",
                "posting_count": 1,
                "eu": True,
            },
        ])

        result = await run(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert len(result) == 1
        assert "eu" not in result[0]

    @pytest.mark.asyncio()
    async def test_workday_url_re_inference(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, [])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "nvidia",
                "name": "NVIDIA",
                "inferred_ats": None,
                "inferred_board_token": None,
                "apply_url": (
                    "https://nvidia.wd5.myworkdayjobs.com/en-US"
                    "/NVIDIAExternalCareerSite/job/SWE-Intern/123"
                ),
                "posting_count": 5,
            },
        ])

        result = await run(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert len(result) == 1
        assert result[0]["inferred_ats"] == "workday"
        assert (
            result[0]["inferred_board_token"]
            == "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
        )

    @pytest.mark.asyncio()
    async def test_smartrecruiters_url_re_inference(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, [])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "visa",
                "name": "Visa",
                "inferred_ats": None,
                "inferred_board_token": None,
                "apply_url": "https://jobs.smartrecruiters.com/Visa/abc",
                "posting_count": 2,
            },
        ])

        result = await run(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert result[0]["inferred_ats"] == "smartrecruiters"
        assert result[0]["inferred_board_token"] == "Visa"

    @pytest.mark.asyncio()
    async def test_unknown_url_stays_null(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()

        registry_path = tmp_path / "companies.yaml"
        self._write_registry(registry_path, [])

        self._write_candidates(data_dir / "registry_candidates.json", [
            {
                "slug": "google",
                "name": "Google",
                "inferred_ats": "greenhouse",
                "inferred_board_token": "google",
                "apply_url": "https://careers.google.com/jobs/123",
                "posting_count": 10,
            },
        ])

        result = await run(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert result[0]["inferred_ats"] is None
        assert result[0]["inferred_board_token"] is None
