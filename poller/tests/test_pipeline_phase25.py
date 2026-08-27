from __future__ import annotations

import dataclasses
import json
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest
import yaml

from poller.exceptions import SourceFetchError
from poller.main import run_pipeline
from poller.models import Company, Posting, RawPosting, SourceHealth
from poller.store import RunState, load_feed, load_state, save_state
from poller.tests.conftest import make_company, make_posting

if TYPE_CHECKING:
    from pathlib import Path


def _write_registry(path: Path, companies: list[Company]) -> None:
    entries: list[dict[str, Any]] = []
    for c in companies:
        entry: dict[str, Any] = {
            "slug": c.slug,
            "name": c.name,
            "tags": c.tags,
            "sources": [
                {"type": s.type, "board_token": s.board_token, "eu": s.eu}
                for s in c.sources
            ],
        }
        if c.typical_open:
            entry["typical_open"] = c.typical_open
        if c.high_priority:
            entry["high_priority"] = c.high_priority
        entries.append(entry)
    path.write_text(yaml.dump(entries), encoding="utf-8")


def _seed_state(
    state_path: Path,
    sources: dict[str, SourceHealth] | None = None,
    run_count: int = 1,
    active_ids: set[str] | None = None,
) -> None:
    state = RunState(
        last_run_at="2026-09-01T00:00:00Z",
        run_count=run_count,
        sources=sources or {},
        active_ids=active_ids or set(),
    )
    save_state(state_path, state)


class _FakeAdapter:
    def __init__(
        self,
        postings: list[Posting],
        *,
        fail: bool = False,
        error_msg: str = "HTTP 500",
    ) -> None:
        self._postings = postings
        self._fail = fail
        self._error_msg = error_msg
        self.potentially_truncated = False

    async def fetch(self, client: Any, company: Any, source: Any) -> list[RawPosting]:
        if self._fail:
            raise SourceFetchError(
                source=source.type if source else "simplify",
                company_slug=company.slug if company else "__simplify__",
                message=self._error_msg,
            )
        raws = []
        for p in self._postings:
            raws.append(
                RawPosting(
                    source=p.source,
                    company_slug=p.company_slug,
                    source_job_id=p.source_job_id,
                    title=p.title,
                    location=p.location,
                    locations=list(p.locations),
                    url=p.url,
                    posted_at=p.posted_at,
                    description="Test description",
                    raw_data=p.source_metadata or {},
                )
            )
        return raws

    def normalize(self, raw: RawPosting, company: Any, now: str) -> Posting:
        for p in self._postings:
            if p.source_job_id == raw.source_job_id:
                return dataclasses.replace(
                    p,
                    first_seen_at=now,
                    last_seen_at=now,
                )
        raise ValueError(f"unexpected raw posting: {raw.source_job_id}")


def _make_simplify_fetch(adapter: _FakeAdapter) -> Any:
    async def fake_fetch_simplify(
        companies: Any, state: Any, now_str: str, skip_reg_cand: Any, data_dir: Any,
    ) -> list[Posting]:
        raw = await adapter.fetch(None, None, None)
        return [adapter.normalize(r, None, now_str) for r in raw]
    return fake_fetch_simplify


@pytest.mark.asyncio()
class TestSimplifyDedupIntegration:
    async def test_greenhouse_wins_over_simplify(self, tmp_path: Path) -> None:
        """Direct ATS posting dedupes away overlapping Simplify posting."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        gh_company = make_company(
            slug="acme", name="Acme", source_type="greenhouse",
            board_token="acme",
        )
        _write_registry(registry_path, [gh_company])

        gh_posting = make_posting(
            pid="gh_acme_swe",
            company="Acme",
            company_slug="acme",
            title="Software Engineering Intern",
            source="greenhouse",
            source_job_id="gh_1001",
            location="New York, NY",
        )
        simplify_posting = make_posting(
            pid="sim_acme_swe",
            company="Acme",
            company_slug="acme",
            title="Software Engineering Intern",
            source="simplify",
            source_job_id="sim_1001",
            location="New York, NY",
        )

        gh_adapter = _FakeAdapter([gh_posting])
        sim_adapter = _FakeAdapter([simplify_posting])

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return {"greenhouse": gh_adapter}[source_type]

        with (
            patch("poller.main.get_adapter", side_effect=fake_get_adapter),
            patch(
                "poller.main._fetch_simplify",
                side_effect=_make_simplify_fetch(sim_adapter),
            ),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=False,
                skip_registry_candidates=True,
            )

        feed = load_feed(data_dir / "feed.json")

        acme_postings = [p for p in feed.values() if p.company_slug == "acme"]
        acme_sources = {p.source for p in acme_postings}

        assert "greenhouse" in acme_sources
        assert "simplify" not in acme_sources

        gh_found = [p for p in acme_postings if p.source == "greenhouse"]
        assert len(gh_found) == 1
        assert simplify_posting.id in gh_found[0].merged_from


@pytest.mark.asyncio()
class TestWorkdayFaultIsolation:
    async def test_workday_failure_does_not_block_others(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        wd_company = make_company(
            slug="nvidia",
            name="NVIDIA",
            source_type="workday",
            board_token="nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
        )
        gh_company = make_company(
            slug="alpha", name="Alpha", source_type="greenhouse",
            board_token="alpha",
        )
        lv_company = make_company(
            slug="beta", name="Beta", source_type="lever",
            board_token="beta",
        )
        _write_registry(registry_path, [wd_company, gh_company, lv_company])

        gh_posting = make_posting(
            pid="gh_alpha_1", company="Alpha", company_slug="alpha",
            title="SWE Intern", source="greenhouse", source_job_id="1001",
        )
        lv_posting = make_posting(
            pid="lv_beta_1", company="Beta", company_slug="beta",
            title="Backend Eng", source="lever", source_job_id="2001",
        )

        adapters = {
            "workday": _FakeAdapter([], fail=True, error_msg="Workday throttled"),
            "greenhouse": _FakeAdapter([gh_posting]),
            "lever": _FakeAdapter([lv_posting]),
        }

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return adapters[source_type]

        with patch("poller.main.get_adapter", side_effect=fake_get_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )

        feed = load_feed(data_dir / "feed.json")
        state = load_state(data_dir / "state.json")

        gh_ids = {pid for pid, p in feed.items() if p.source == "greenhouse"}
        lv_ids = {pid for pid, p in feed.items() if p.source == "lever"}
        wd_ids = {pid for pid, p in feed.items() if p.source == "workday"}

        assert len(gh_ids) == 1
        assert len(lv_ids) == 1
        assert len(wd_ids) == 0

        wd_health = state.sources.get("workday:nvidia")
        assert wd_health is not None
        assert wd_health.healthy is False
        assert "throttled" in (wd_health.error or "").lower()

        gh_health = state.sources.get("greenhouse:alpha")
        assert gh_health is not None
        assert gh_health.healthy is True


@pytest.mark.asyncio()
class TestSmartRecruitersPagination:
    async def test_all_smartrecruiters_postings_collected(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        sr_company = make_company(
            slug="testcorp-sr",
            name="TestCorp SR",
            source_type="smartrecruiters",
            board_token="TestCorp",
        )
        _write_registry(registry_path, [sr_company])

        sr_posts = [
            make_posting(
                pid=f"sr_tc_{i}",
                company="TestCorp SR",
                company_slug="testcorp-sr",
                title=f"Role {i}",
                source="smartrecruiters",
                source_job_id=f"sr-{i:03d}",
            )
            for i in range(5)
        ]

        sr_adapter = _FakeAdapter(sr_posts)

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return {"smartrecruiters": sr_adapter}[source_type]

        with patch("poller.main.get_adapter", side_effect=fake_get_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )

        feed = load_feed(data_dir / "feed.json")
        sr_postings = [p for p in feed.values() if p.source == "smartrecruiters"]
        assert len(sr_postings) == 5


@pytest.mark.asyncio()
class TestSourceMetadataPassthrough:
    async def test_simplify_metadata_in_feed_json(
        self, tmp_path: Path,
    ) -> None:
        """Simplify posting with sponsorship metadata survives into feed.json."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        _write_registry(registry_path, [])

        sim_posting = make_posting(
            pid="sim_meta_1",
            company="MetaCo",
            company_slug="metaco",
            title="ML Engineer Intern",
            source="simplify",
            source_job_id="meta-001",
        )
        sim_posting = dataclasses.replace(
            sim_posting,
            source_metadata={
                "sponsorship": "Offers Sponsorship",
                "terms": ["Summer 2027"],
                "category": "Data Science, AI & Machine Learning",
            },
        )

        sim_adapter = _FakeAdapter([sim_posting])

        with patch(
            "poller.main._fetch_simplify",
            side_effect=_make_simplify_fetch(sim_adapter),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=False,
                skip_registry_candidates=True,
            )

        feed = load_feed(data_dir / "feed.json")
        assert len(feed) == 1

        posting = next(iter(feed.values()))
        assert posting.source_metadata is not None
        assert posting.source_metadata["sponsorship"] == "Offers Sponsorship"
        assert "Summer 2027" in posting.source_metadata["terms"]

        raw_feed = json.loads(
            (data_dir / "feed.json").read_text(encoding="utf-8"),
        )
        raw_posting = next(iter(raw_feed["postings"].values()))
        assert "source_metadata" in raw_posting
        assert raw_posting["source_metadata"]["sponsorship"] == "Offers Sponsorship"


@pytest.mark.asyncio()
class TestAllSixAdapters:
    async def test_mixed_source_pipeline(self, tmp_path: Path) -> None:
        """Full pipeline with all 6 sources. Dedupe fires on overlaps.
        Source priority respected — Greenhouse beats Simplify."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        companies = [
            make_company(
                slug="alpha", name="Alpha", source_type="greenhouse",
                board_token="alpha",
            ),
            make_company(
                slug="beta", name="Beta", source_type="lever",
                board_token="beta",
            ),
            make_company(
                slug="gamma", name="Gamma", source_type="ashby",
                board_token="gamma",
            ),
            make_company(
                slug="delta", name="Delta", source_type="workday",
                board_token="delta.wd5.myworkdayjobs.com/DeltaCareers",
            ),
            make_company(
                slug="epsilon", name="Epsilon", source_type="smartrecruiters",
                board_token="Epsilon",
            ),
        ]
        _write_registry(registry_path, companies)

        gh_posts = [
            make_posting(
                pid="gh_a_1", company="Alpha", company_slug="alpha",
                title="SWE Intern", source="greenhouse", source_job_id="g1",
            ),
            make_posting(
                pid="gh_a_2", company="Alpha", company_slug="alpha",
                title="ML Intern", source="greenhouse", source_job_id="g2",
            ),
        ]
        lv_posts = [
            make_posting(
                pid="lv_b_1", company="Beta", company_slug="beta",
                title="Backend Eng", source="lever", source_job_id="l1",
            ),
        ]
        ab_posts = [
            make_posting(
                pid="ab_g_1", company="Gamma", company_slug="gamma",
                title="Platform Eng", source="ashby", source_job_id="a1",
            ),
        ]
        wd_posts = [
            make_posting(
                pid="wd_d_1", company="Delta", company_slug="delta",
                title="Infra Intern", source="workday", source_job_id="w1",
            ),
        ]
        sr_posts = [
            make_posting(
                pid="sr_e_1", company="Epsilon", company_slug="epsilon",
                title="QA Intern", source="smartrecruiters", source_job_id="s1",
            ),
        ]

        sim_overlap = make_posting(
            pid="sim_a_swe", company="Alpha", company_slug="alpha",
            title="SWE Intern", source="simplify", source_job_id="sim_g1",
            location="New York, NY",
        )
        sim_unique = make_posting(
            pid="sim_zeta_1", company="Zeta", company_slug="zeta",
            title="Data Eng Intern", source="simplify", source_job_id="sim_z1",
        )

        adapters = {
            "greenhouse": _FakeAdapter(gh_posts),
            "lever": _FakeAdapter(lv_posts),
            "ashby": _FakeAdapter(ab_posts),
            "workday": _FakeAdapter(wd_posts),
            "smartrecruiters": _FakeAdapter(sr_posts),
        }

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return adapters[source_type]

        sim_adapter = _FakeAdapter([sim_overlap, sim_unique])

        with (
            patch("poller.main.get_adapter", side_effect=fake_get_adapter),
            patch(
                "poller.main._fetch_simplify",
                side_effect=_make_simplify_fetch(sim_adapter),
            ),
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

        sources_in_feed = {p.source for p in feed.values()}
        assert "greenhouse" in sources_in_feed
        assert "lever" in sources_in_feed
        assert "ashby" in sources_in_feed
        assert "workday" in sources_in_feed
        assert "smartrecruiters" in sources_in_feed
        assert "simplify" in sources_in_feed

        alpha_postings = [p for p in feed.values() if p.company_slug == "alpha"]
        alpha_sources = {p.source for p in alpha_postings}
        assert "greenhouse" in alpha_sources
        assert "simplify" not in alpha_sources

        gh_swe = [
            p for p in alpha_postings
            if p.source == "greenhouse" and "SWE" in p.title
        ]
        assert len(gh_swe) == 1
        assert sim_overlap.id in gh_swe[0].merged_from

        zeta_postings = [p for p in feed.values() if p.company_slug == "zeta"]
        assert len(zeta_postings) == 1
        assert zeta_postings[0].source == "simplify"

        total_direct = 2 + 1 + 1 + 1 + 1
        total_unique_simplify = 1
        assert len(feed) == total_direct + total_unique_simplify

        for key in ["greenhouse:alpha", "lever:beta", "ashby:gamma",
                     "workday:delta", "smartrecruiters:epsilon"]:
            health = state.sources.get(key)
            assert health is not None, f"missing health for {key}"
            assert health.healthy is True, f"{key} not healthy"
