"""Phase 2.5 exit tests — full pipeline integration against fixture data.

Unlike Block 9 tests which mock adapter internals, these drive real adapter
code against committed fixture files. They catch integration bugs in
serialization, ID computation, throttle timing, and cross-source dedupe.
"""
from __future__ import annotations

import dataclasses
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import yaml

from poller.http import USER_AGENT, RateLimitedClient
from poller.main import run_pipeline
from poller.models import Company, Posting, RawPosting, SourceConfig
from poller.sources.simplify import SimplifyAdapter, generate_registry_candidates
from poller.sources.workday import WORKDAY_PAGE_LIMIT, WorkdayAdapter
from poller.store import load_feed, load_state
from poller.tests.conftest import make_posting

FIXTURE_DIR = Path(__file__).parent / "fixtures"
GOLDEN_TIME = "2026-09-15T12:00:00Z"
GOLDEN_DT = datetime(2026, 9, 15, 12, 0, 0, tzinfo=UTC)


def _load_fixture_bytes(adapter: str, name: str) -> bytes:
    return (FIXTURE_DIR / adapter / f"{name}.json").read_bytes()


def _write_registry(path: Path, companies: list[dict[str, Any]]) -> None:
    path.write_text(yaml.dump(companies), encoding="utf-8")


# ---------------------------------------------------------------------------
# Transport helpers
# ---------------------------------------------------------------------------

class _WorkdayPageTransport(httpx.AsyncBaseTransport):
    """Serves Workday multipage fixtures in order. Records all requests."""

    def __init__(self, pages: list[bytes]) -> None:
        self._pages = list(pages)
        self._call_idx = 0
        self.requests: list[httpx.Request] = []

    async def handle_async_request(
        self, request: httpx.Request,
    ) -> httpx.Response:
        self.requests.append(request)
        body = self._pages[min(self._call_idx, len(self._pages) - 1)]
        self._call_idx += 1
        return httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=body,
            stream=httpx.ByteStream(body),
        )


class _WorkdayThrottleTransport(httpx.AsyncBaseTransport):
    """Page 1 OK, page 2 empty (throttle), page 2 retry OK, page 3 OK."""

    def __init__(self) -> None:
        self._page1 = _load_fixture_bytes("workday", "multipage_page1")
        self._page2_empty = _load_fixture_bytes("workday", "throttle_page2_empty")
        self._page2_ok = _load_fixture_bytes("workday", "throttle_page2_retry")
        self._page3 = _load_fixture_bytes("workday", "multipage_page3")
        self._call_idx = 0
        self.requests: list[httpx.Request] = []

    async def handle_async_request(
        self, request: httpx.Request,
    ) -> httpx.Response:
        self.requests.append(request)
        sequence = [
            self._page1,
            self._page2_empty,
            self._page2_ok,
            self._page3,
        ]
        body = sequence[min(self._call_idx, len(sequence) - 1)]
        self._call_idx += 1
        return httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=body,
            stream=httpx.ByteStream(body),
        )


class _FakeAdapter:
    """Minimal adapter mock for pipeline integration."""

    def __init__(self, postings: list[Posting]) -> None:
        self._postings = postings
        self.potentially_truncated = False

    async def fetch(
        self, client: Any, company: Any, source: Any,
    ) -> list[RawPosting]:
        return [
            RawPosting(
                source=p.source, company_slug=p.company_slug,
                source_job_id=p.source_job_id, title=p.title,
                location=p.location, locations=list(p.locations),
                url=p.url, posted_at=p.posted_at, description="",
                raw_data={},
            )
            for p in self._postings
        ]

    def normalize(
        self, raw: RawPosting, company: Any, now: str,
    ) -> Posting:
        for p in self._postings:
            if p.source_job_id == raw.source_job_id:
                return dataclasses.replace(
                    p, first_seen_at=now, last_seen_at=now,
                )
        msg = f"no match for {raw.source_job_id}"
        raise ValueError(msg)


# ===========================================================================
# Exit Test 1: Workday Pagination Safety
# ===========================================================================

@pytest.mark.asyncio()
class TestWorkdayPaginationSafety:
    """Most critical test — limit>20 silently returns zero data."""

    async def test_three_page_requests_with_limit_20(self) -> None:
        transport = _WorkdayPageTransport([
            _load_fixture_bytes("workday", "multipage_page1"),
            _load_fixture_bytes("workday", "multipage_page2"),
            _load_fixture_bytes("workday", "multipage_page3"),
        ])

        async with httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(5.0),
            headers={"User-Agent": USER_AGENT},
        ) as raw_client:
            client = RateLimitedClient()
            client._client = raw_client

            adapter = WorkdayAdapter()
            company = Company(
                slug="nvidia", name="NVIDIA",
                tags=["hardware"],
                sources=[SourceConfig(
                    type="workday",
                    board_token="nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
                )],
            )

            with patch("poller.sources.workday.asyncio.sleep", return_value=None):
                raw_postings = await adapter.fetch(
                    client, company, company.sources[0],
                )

        assert len(raw_postings) == 55
        assert len(transport.requests) == 3

        for req in transport.requests:
            body = json.loads(req.content)
            assert body["limit"] == WORKDAY_PAGE_LIMIT
            assert body["limit"] == 20


# ===========================================================================
# Exit Test 2: Simplify Dedup Priority
# ===========================================================================

@pytest.mark.asyncio()
class TestSimplifyDedupPriority:
    """Greenhouse direct source beats Simplify aggregator — user gets real URL."""

    async def test_greenhouse_canonical_over_simplify(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        _write_registry(registry_path, [
            {
                "slug": "acme",
                "name": "Acme Inc",
                "tags": ["tech"],
                "sources": [{"type": "greenhouse", "board_token": "acme"}],
            },
        ])

        gh_posting = make_posting(
            pid="gh_acme_swe",
            company="Acme Inc",
            company_slug="acme",
            title="Software Engineering Intern",
            source="greenhouse",
            source_job_id="gh_1001",
            location="San Francisco, CA",
        )
        sim_posting = make_posting(
            pid="sim_acme_swe",
            company="Acme Inc",
            company_slug="acme",
            title="Software Engineering Intern",
            source="simplify",
            source_job_id="sim_1001",
            location="San Francisco, CA",
        )

        gh_adapter = _FakeAdapter([gh_posting])

        async def fake_simplify(
            companies: Any, state: Any, now_str: str,
            skip_reg: bool, data_dir: Path,
        ) -> list[Posting]:
            return [dataclasses.replace(
                sim_posting, first_seen_at=now_str, last_seen_at=now_str,
            )]

        with (
            patch("poller.main.get_adapter", return_value=gh_adapter),
            patch("poller.main._fetch_simplify", side_effect=fake_simplify),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=False,
                skip_registry_candidates=True,
            )

        feed = load_feed(data_dir / "feed.json")

        acme = [p for p in feed.values() if p.company_slug == "acme"]
        assert len(acme) == 1
        assert acme[0].source == "greenhouse"
        assert sim_posting.id in acme[0].merged_from
        assert "greenhouse.io" in acme[0].url


# ===========================================================================
# Exit Test 3: Source Metadata Lifecycle
# ===========================================================================

@pytest.mark.asyncio()
class TestSourceMetadataLifecycle:
    """Simplify sponsorship metadata persists through pipeline into feed.json."""

    async def test_metadata_survives_pipeline(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, [])

        sim_posting = make_posting(
            pid="sim_meta_lc",
            company="LifecycleCo",
            company_slug="lifecycleco",
            title="Backend Intern",
            source="simplify",
            source_job_id="lc-001",
        )
        sim_posting = dataclasses.replace(
            sim_posting,
            source_metadata={
                "sponsorship": "Doesn't Offer Sponsorship",
                "terms": ["Summer 2027"],
                "degrees": ["Bachelor's"],
                "category": "Software Engineering",
            },
        )

        async def fake_simplify(
            companies: Any, state: Any, now_str: str,
            skip_reg: bool, data_dir: Path,
        ) -> list[Posting]:
            return [dataclasses.replace(
                sim_posting, first_seen_at=now_str, last_seen_at=now_str,
            )]

        with patch(
            "poller.main._fetch_simplify", side_effect=fake_simplify,
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=False,
                skip_registry_candidates=True,
            )

        raw = json.loads(
            (data_dir / "feed.json").read_text(encoding="utf-8"),
        )
        raw_posting = next(iter(raw["postings"].values()))

        assert "source_metadata" in raw_posting
        meta = raw_posting["source_metadata"]
        assert meta["sponsorship"] == "Doesn't Offer Sponsorship"
        assert "Summer 2027" in meta["terms"]
        assert "Bachelor's" in meta["degrees"]
        assert meta["category"] == "Software Engineering"


# ===========================================================================
# Exit Test 4: Registry Candidates Output
# ===========================================================================

@pytest.mark.asyncio()
class TestRegistryCandidatesOutput:
    """Simplify fixture with known slugs filters correctly."""

    async def test_known_slugs_excluded_from_candidates(
        self, tmp_path: Path,
    ) -> None:
        transport = httpx.MockTransport(
            lambda req: httpx.Response(
                200,
                content=_load_fixture_bytes(
                    "simplify", "active_visible_listings",
                ),
                headers={"content-type": "text/plain"},
            ),
        )

        async with httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(5.0),
            headers={"User-Agent": USER_AGENT},
        ) as raw_client:
            client = RateLimitedClient()
            client._client = raw_client

            adapter = SimplifyAdapter()
            dummy = Company(
                slug="__simplify__", name="Simplify",
                tags=[], sources=[],
            )
            dummy_src = SourceConfig(type="simplify", board_token="")

            raw_postings = await adapter.fetch(client, dummy, dummy_src)
            postings = [
                adapter.normalize(r, dummy, GOLDEN_TIME) for r in raw_postings
            ]

        all_slugs = {p.company_slug for p in postings}
        known_slugs = set(list(all_slugs)[:10])

        candidates_path = tmp_path / "registry_candidates.json"
        generate_registry_candidates(postings, known_slugs, candidates_path)

        candidates = json.loads(candidates_path.read_text(encoding="utf-8"))
        candidate_slugs = {c["slug"] for c in candidates}

        for slug in known_slugs:
            assert slug not in candidate_slugs, f"{slug} should be excluded"

        for c in candidates:
            if c.get("inferred_ats"):
                assert c["inferred_ats"] in {
                    "greenhouse", "lever", "ashby", "workday", "smartrecruiters",
                }
                assert c.get("inferred_board_token") is not None


# ===========================================================================
# Exit Test 5: Workday Throttle Recovery
# ===========================================================================

@pytest.mark.asyncio()
class TestWorkdayThrottleRecovery:
    """Page 2 throttle then retry then success — all 55 postings collected."""

    async def test_throttle_retry_collects_all(self) -> None:
        transport = _WorkdayThrottleTransport()

        async with httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(5.0),
            headers={"User-Agent": USER_AGENT},
        ) as raw_client:
            client = RateLimitedClient()
            client._client = raw_client

            adapter = WorkdayAdapter()
            company = Company(
                slug="nvidia", name="NVIDIA",
                tags=["hardware"],
                sources=[SourceConfig(
                    type="workday",
                    board_token="nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
                )],
            )

            with patch(
                "poller.sources.workday.asyncio.sleep", return_value=None,
            ):
                raw_postings = await adapter.fetch(
                    client, company, company.sources[0],
                )

        assert len(raw_postings) == 55
        # page1 + page2_fail + page2_retry + page3
        assert len(transport.requests) == 4


# ===========================================================================
# Exit Test 6: Mixed Source Pipeline
# ===========================================================================

@pytest.mark.asyncio()
class TestMixedSourcePipeline:
    """Full pipeline with all 6 sources — verifies dedup and source priority."""

    async def test_six_source_dedup_and_counts(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        companies_yaml = [
            {"slug": "co-gh", "name": "GH Co", "tags": ["tech"],
             "sources": [{"type": "greenhouse", "board_token": "cogh"}]},
            {"slug": "co-lv", "name": "LV Co", "tags": ["tech"],
             "sources": [{"type": "lever", "board_token": "colv"}]},
            {"slug": "co-ab", "name": "AB Co", "tags": ["tech"],
             "sources": [{"type": "ashby", "board_token": "coab"}]},
            {"slug": "co-wd", "name": "WD Co", "tags": ["tech"],
             "sources": [{"type": "workday",
                          "board_token": "cowd.wd5.myworkdayjobs.com/CowdCareers"}]},
            {"slug": "co-sr", "name": "SR Co", "tags": ["tech"],
             "sources": [{"type": "smartrecruiters", "board_token": "SRCo"}]},
        ]
        _write_registry(registry_path, companies_yaml)

        postings_by_source: dict[str, list[Posting]] = {
            "greenhouse": [make_posting(
                pid="p_gh1", company="GH Co", company_slug="co-gh",
                title="SWE Intern", source="greenhouse", source_job_id="g1",
            )],
            "lever": [make_posting(
                pid="p_lv1", company="LV Co", company_slug="co-lv",
                title="Backend Eng", source="lever", source_job_id="l1",
            )],
            "ashby": [make_posting(
                pid="p_ab1", company="AB Co", company_slug="co-ab",
                title="Platform Eng", source="ashby", source_job_id="a1",
            )],
            "workday": [make_posting(
                pid="p_wd1", company="WD Co", company_slug="co-wd",
                title="Infra Intern", source="workday", source_job_id="w1",
            )],
            "smartrecruiters": [make_posting(
                pid="p_sr1", company="SR Co", company_slug="co-sr",
                title="QA Intern", source="smartrecruiters", source_job_id="s1",
            )],
        }

        sim_overlap = make_posting(
            pid="sim_gh_dup", company="GH Co", company_slug="co-gh",
            title="SWE Intern", source="simplify", source_job_id="sim_g1",
        )
        sim_unique = make_posting(
            pid="sim_uniq", company="Only Sim Co", company_slug="only-sim-co",
            title="Data Eng Intern", source="simplify", source_job_id="sim_u1",
        )

        adapters = {
            k: _FakeAdapter(v) for k, v in postings_by_source.items()
        }

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return adapters[source_type]

        async def fake_simplify(
            companies: Any, state: Any, now_str: str,
            skip_reg: bool, data_dir: Path,
        ) -> list[Posting]:
            return [
                dataclasses.replace(
                    sim_overlap, first_seen_at=now_str, last_seen_at=now_str,
                ),
                dataclasses.replace(
                    sim_unique, first_seen_at=now_str, last_seen_at=now_str,
                ),
            ]

        with (
            patch("poller.main.get_adapter", side_effect=fake_get_adapter),
            patch("poller.main._fetch_simplify", side_effect=fake_simplify),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=False,
                skip_registry_candidates=True,
            )

        feed = load_feed(data_dir / "feed.json")
        state = load_state(data_dir / "state.json")

        sources_present = {p.source for p in feed.values()}
        assert "greenhouse" in sources_present
        assert "lever" in sources_present
        assert "ashby" in sources_present
        assert "workday" in sources_present
        assert "smartrecruiters" in sources_present
        assert "simplify" in sources_present

        co_gh = [p for p in feed.values() if p.company_slug == "co-gh"]
        assert len(co_gh) == 1
        assert co_gh[0].source == "greenhouse"
        assert sim_overlap.id in co_gh[0].merged_from

        sim_only = [
            p for p in feed.values() if p.company_slug == "only-sim-co"
        ]
        assert len(sim_only) == 1
        assert sim_only[0].source == "simplify"

        # 5 direct + 1 unique Simplify = 6 total (overlap deduped)
        assert len(feed) == 6

        for key in [
            "greenhouse:co-gh", "lever:co-lv", "ashby:co-ab",
            "workday:co-wd", "smartrecruiters:co-sr",
        ]:
            health = state.sources.get(key)
            assert health is not None, f"missing health for {key}"
            assert health.healthy is True
