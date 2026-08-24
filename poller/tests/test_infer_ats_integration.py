"""Integration test: Simplify adapter -> registry_candidates.json -> infer_ats pipeline.

Tests the full chain: fixture data through SimplifyAdapter normalization,
generate_registry_candidates output, then infer_ats enrichment. No mocked
adapter internals — uses real adapter code against committed fixtures.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml

from poller.http import USER_AGENT, RateLimitedClient
from poller.models import Company, SourceConfig
from poller.sources.simplify import SimplifyAdapter, generate_registry_candidates
from poller.tools.infer_ats import run as run_infer_ats

FIXTURE_DIR = Path(__file__).parent / "fixtures"
GOLDEN_TIME = "2026-09-15T12:00:00Z"


def _load_fixture_bytes(adapter: str, name: str) -> bytes:
    return (FIXTURE_DIR / adapter / f"{name}.json").read_bytes()


class _SimplifyTransport(httpx.AsyncBaseTransport):
    def __init__(self, fixture_name: str) -> None:
        self._body = _load_fixture_bytes("simplify", fixture_name)

    async def handle_async_request(
        self, request: httpx.Request,
    ) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            headers={"content-type": "text/plain; charset=utf-8"},
            content=self._body,
            stream=httpx.ByteStream(self._body),
        )


def _write_registry(path: Path, slugs: list[str]) -> None:
    entries = [
        {
            "slug": slug,
            "name": slug.replace("-", " ").title(),
            "tags": ["tech"],
            "sources": [{"type": "greenhouse", "board_token": slug}],
        }
        for slug in slugs
    ]
    path.write_text(yaml.dump(entries), encoding="utf-8")


async def _run_simplify_adapter(fixture_name: str) -> list[Any]:
    """Run real SimplifyAdapter.fetch + normalize against a fixture."""
    transport = _SimplifyTransport(fixture_name)

    async with httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(5.0),
        headers={"User-Agent": USER_AGENT},
    ) as raw_client:
        client = RateLimitedClient()
        client._client = raw_client

        adapter = SimplifyAdapter()
        dummy_company = Company(
            slug="__simplify__", name="Simplify",
            tags=[], sources=[],
        )
        dummy_source = SourceConfig(type="simplify", board_token="")

        raw_postings = await adapter.fetch(client, dummy_company, dummy_source)
        postings = [
            adapter.normalize(raw, dummy_company, GOLDEN_TIME)
            for raw in raw_postings
        ]

    return postings


@pytest.mark.asyncio()
class TestSimplifyToCandidatesChain:
    async def test_active_visible_produce_candidates(
        self, tmp_path: Path,
    ) -> None:
        """Simplify active_visible fixture produces registry candidates
        with correct ATS inference for Greenhouse/Lever/Ashby/Workday/SR URLs."""
        postings = await _run_simplify_adapter("active_visible_listings")
        assert len(postings) > 0

        known_slugs = {"watershed", "palantir", "testco"}
        candidates_path = tmp_path / "registry_candidates.json"
        generate_registry_candidates(postings, known_slugs, candidates_path)

        assert candidates_path.exists()
        candidates = json.loads(candidates_path.read_text(encoding="utf-8"))
        assert len(candidates) > 0

        candidate_slugs = {c["slug"] for c in candidates}
        assert "watershed" not in candidate_slugs
        assert "palantir" not in candidate_slugs
        assert "testco" not in candidate_slugs

        greenhouse_candidates = [
            c for c in candidates if c.get("inferred_ats") == "greenhouse"
        ]
        assert len(greenhouse_candidates) > 0

        lever_candidates = [
            c for c in candidates if c.get("inferred_ats") == "lever"
        ]
        assert len(lever_candidates) > 0

        ashby_candidates = [
            c for c in candidates if c.get("inferred_ats") == "ashby"
        ]
        assert len(ashby_candidates) > 0

        workday_candidates = [
            c for c in candidates if c.get("inferred_ats") == "workday"
        ]
        assert len(workday_candidates) > 0

        sr_candidates = [
            c for c in candidates if c.get("inferred_ats") == "smartrecruiters"
        ]
        assert len(sr_candidates) > 0

    async def test_unknown_urls_excluded_from_candidates(
        self, tmp_path: Path,
    ) -> None:
        """Companies with custom ATS URLs (google, amazon, apple, etc.)
        are excluded from candidates because generate_registry_candidates
        skips entries where inferred_ats is 'other'."""
        postings = await _run_simplify_adapter("active_visible_listings")

        known_slugs: set[str] = set()
        candidates_path = tmp_path / "registry_candidates.json"
        generate_registry_candidates(postings, known_slugs, candidates_path)

        candidates = json.loads(candidates_path.read_text(encoding="utf-8"))
        candidate_slugs = {c["slug"] for c in candidates}

        assert "google" not in candidate_slugs
        assert "amazon" not in candidate_slugs
        assert "apple" not in candidate_slugs
        assert "meta" not in candidate_slugs
        assert "netflix" not in candidate_slugs
        assert "microsoft" not in candidate_slugs


@pytest.mark.asyncio()
class TestCandidatesToInferATS:
    async def test_full_chain_simplify_to_infer(
        self, tmp_path: Path,
    ) -> None:
        """Full chain: Simplify -> generate_registry_candidates -> infer_ats.run().

        Verifies ATS types and tokens correctly inferred and existing
        registry companies excluded."""
        postings = await _run_simplify_adapter("active_visible_listings")

        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        existing_slugs = {"stripe", "watershed"}
        _write_registry(registry_path, list(existing_slugs))

        candidates_path = data_dir / "registry_candidates.json"
        generate_registry_candidates(postings, existing_slugs, candidates_path)

        candidates_before = json.loads(
            candidates_path.read_text(encoding="utf-8"),
        )
        assert all(
            c["slug"] not in existing_slugs for c in candidates_before
        )

        result = await run_infer_ats(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        assert len(result) > 0

        result_slugs = {c["slug"] for c in result}
        assert "stripe" not in result_slugs
        assert "watershed" not in result_slugs

        for candidate in result:
            ats = candidate.get("inferred_ats")
            token = candidate.get("inferred_board_token")
            if ats is not None:
                assert ats in {
                    "greenhouse", "lever", "ashby", "workday", "smartrecruiters",
                }
                assert token is not None
                assert len(token) > 0

    async def test_workday_tokens_inferred_correctly(
        self, tmp_path: Path,
    ) -> None:
        """Workday URLs produce host/site board tokens."""
        postings = await _run_simplify_adapter("active_visible_listings")

        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, [])

        candidates_path = data_dir / "registry_candidates.json"
        generate_registry_candidates(postings, set(), candidates_path)

        result = await run_infer_ats(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        workday_entries = [
            c for c in result if c.get("inferred_ats") == "workday"
        ]
        assert len(workday_entries) > 0

        for entry in workday_entries:
            token = entry["inferred_board_token"]
            assert ".myworkdayjobs.com/" in token or "wd" in token.split(".")[0]

    async def test_greenhouse_tokens_inferred_correctly(
        self, tmp_path: Path,
    ) -> None:
        """Greenhouse URLs produce correct board tokens."""
        postings = await _run_simplify_adapter("active_visible_listings")

        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, [])

        candidates_path = data_dir / "registry_candidates.json"
        generate_registry_candidates(postings, set(), candidates_path)

        result = await run_infer_ats(
            data_dir=data_dir,
            registry_path=registry_path,
        )

        gh_entries = [
            c for c in result if c.get("inferred_ats") == "greenhouse"
        ]
        assert len(gh_entries) > 0

        for entry in gh_entries:
            token = entry["inferred_board_token"]
            assert token is not None
            assert "/" not in token
