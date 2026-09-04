from __future__ import annotations

import dataclasses
import hashlib
import json
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest

from poller.exceptions import SourceFetchError
from poller.main import run_pipeline
from poller.models import Company, Posting, RawPosting, SourceHealth
from poller.store import RunState, load_feed, load_state, save_feed, save_state
from poller.tests.conftest import make_company, make_posting, make_source_health

if TYPE_CHECKING:
    from pathlib import Path


def _write_registry(path: Path, companies: list[Company]) -> None:
    import yaml

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


def _greenhouse_postings(company_slug: str) -> list[Posting]:
    return [
        make_posting(
            pid=f"gh_{company_slug}_1",
            company=company_slug.title(),
            company_slug=company_slug,
            title="SWE Intern",
            source="greenhouse",
            source_job_id="1001",
        ),
        make_posting(
            pid=f"gh_{company_slug}_2",
            company=company_slug.title(),
            company_slug=company_slug,
            title="ML Intern",
            source="greenhouse",
            source_job_id="1002",
        ),
    ]


def _lever_postings(company_slug: str) -> list[Posting]:
    return [
        make_posting(
            pid=f"lv_{company_slug}_1",
            company=company_slug.title(),
            company_slug=company_slug,
            title="Backend Engineer Intern",
            source="lever",
            source_job_id="2001",
        ),
    ]


def _ashby_postings(company_slug: str) -> list[Posting]:
    return [
        make_posting(
            pid=f"ab_{company_slug}_1",
            company=company_slug.title(),
            company_slug=company_slug,
            title="Platform Engineer Intern",
            source="ashby",
            source_job_id="3001",
        ),
    ]


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
                source=source.type,
                company_slug=company.slug,
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


@pytest.mark.asyncio()
class TestFaultIsolation:
    async def test_failed_adapter_does_not_block_others(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        gh_company = make_company(
            slug="alpha", name="Alpha", source_type="greenhouse",
            board_token="alpha",
        )
        lv_company = make_company(
            slug="beta", name="Beta", source_type="lever",
            board_token="beta",
        )
        ab_company = make_company(
            slug="gamma", name="Gamma", source_type="ashby",
            board_token="gamma",
        )
        _write_registry(registry_path, [gh_company, lv_company, ab_company])

        gh_posts = _greenhouse_postings("alpha")
        lv_posts = _lever_postings("beta")
        ab_posts = _ashby_postings("gamma")

        gh_adapter = _FakeAdapter(gh_posts, fail=True, error_msg="HTTP 500")
        lv_adapter = _FakeAdapter(lv_posts)
        ab_adapter = _FakeAdapter(ab_posts)

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return {
                "greenhouse": gh_adapter,
                "lever": lv_adapter,
                "ashby": ab_adapter,
            }[source_type]

        with patch("poller.main.get_adapter", side_effect=fake_get_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )

        feed = load_feed(data_dir / "feed.json")
        state = load_state(data_dir / "state.json")

        lever_ids = {pid for pid, p in feed.items() if p.source == "lever"}
        ashby_ids = {pid for pid, p in feed.items() if p.source == "ashby"}
        greenhouse_ids = {
            pid for pid, p in feed.items() if p.source == "greenhouse"
        }

        assert len(lever_ids) == 1
        assert len(ashby_ids) == 1
        assert len(greenhouse_ids) == 0

        gh_health = state.sources.get("greenhouse:alpha")
        assert gh_health is not None
        assert gh_health.healthy is False
        assert "500" in (gh_health.error or "")

        lv_health = state.sources.get("lever:beta")
        assert lv_health is not None
        assert lv_health.healthy is True

        ab_health = state.sources.get("ashby:gamma")
        assert ab_health is not None
        assert ab_health.healthy is True

    async def test_failed_adapter_retains_previous_postings(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        gh_company = make_company(
            slug="alpha", name="Alpha", source_type="greenhouse",
            board_token="alpha",
        )
        _write_registry(registry_path, [gh_company])

        existing_posting = make_posting(
            pid="existing_gh_1",
            company="Alpha",
            company_slug="alpha",
            title="Old SWE Intern Role",
            source="greenhouse",
            source_job_id="999",
        )
        save_feed(
            data_dir / "feed.json",
            {existing_posting.id: existing_posting},
            "2026-08-30T00:00:00Z",
        )
        _seed_state(
            data_dir / "state.json",
            sources={
                "greenhouse:alpha": make_source_health(bootstrapped=True),
            },
            active_ids={existing_posting.id},
        )

        gh_adapter = _FakeAdapter([], fail=True, error_msg="Connection refused")

        with patch("poller.main.get_adapter", return_value=gh_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )

        feed = load_feed(data_dir / "feed.json")
        assert existing_posting.id in feed
        loaded = feed[existing_posting.id]
        assert loaded.title == "Old SWE Intern Role"
        assert loaded.closed_at is None


@pytest.mark.asyncio()
class TestPipelineScopeMigration:
    async def test_out_of_scope_history_is_pruned_immediately(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, [])

        intern = make_posting(
            pid="intern-us",
            title="Software Engineering Intern",
            location="Austin, TX",
        )
        manager = make_posting(
            pid="manager-us",
            title="Engineering Manager",
            location="Austin, TX",
        )
        save_feed(
            data_dir / "feed.json",
            {intern.id: intern, manager.id: manager},
            "2026-08-30T00:00:00Z",
        )
        _seed_state(
            data_dir / "state.json",
            active_ids={intern.id, manager.id},
        )

        await run_pipeline(
            dry_run=True,
            registry_path=registry_path,
            data_dir=data_dir,
            skip_simplify=True,
        )

        feed = load_feed(data_dir / "feed.json")
        state = load_state(data_dir / "state.json")

        assert set(feed) == {intern.id}
        assert manager.id not in state.active_ids
        assert manager.id not in state.absent_ids


@pytest.mark.asyncio()
class TestIdempotency:
    async def test_same_input_twice_produces_same_posting_set(
        self, tmp_path: Path,
    ) -> None:
        data_dir_1 = tmp_path / "run1"
        data_dir_1.mkdir()
        data_dir_2 = tmp_path / "run2"
        data_dir_2.mkdir()

        registry_path = tmp_path / "companies.yaml"
        company = make_company(
            slug="acme", name="Acme", source_type="lever",
            board_token="acme",
        )
        _write_registry(registry_path, [company])

        posts = _lever_postings("acme")

        adapter1 = _FakeAdapter(posts)
        with patch("poller.main.get_adapter", return_value=adapter1):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir_1,
                skip_simplify=True,
            )

        state_1 = load_state(data_dir_1 / "state.json")
        save_state(data_dir_2 / "state.json", state_1)

        feed_1 = load_feed(data_dir_1 / "feed.json")
        save_feed(
            data_dir_2 / "feed.json",
            feed_1,
            state_1.last_run_at or "",
        )

        adapter2 = _FakeAdapter(posts)
        with patch("poller.main.get_adapter", return_value=adapter2):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir_2,
                skip_simplify=True,
            )

        feed_final_1 = load_feed(data_dir_1 / "feed.json")
        feed_final_2 = load_feed(data_dir_2 / "feed.json")

        ids_1 = set(feed_final_1.keys())
        ids_2 = set(feed_final_2.keys())
        assert ids_1 == ids_2

        for pid in ids_1:
            p1 = feed_final_1[pid]
            p2 = feed_final_2[pid]
            assert p1.title == p2.title
            assert p1.source == p2.source
            assert p1.company_slug == p2.company_slug
            assert p1.closed_at == p2.closed_at


@pytest.mark.asyncio()
class TestPipelineMetaFile:
    async def test_meta_json_written_on_changes(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(
            slug="acme", name="Acme", source_type="ashby",
            board_token="acme",
        )
        _write_registry(registry_path, [company])

        posts = _ashby_postings("acme")
        adapter = _FakeAdapter(posts)

        with patch("poller.main.get_adapter", return_value=adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )

        meta_path = data_dir / "meta.json"
        assert meta_path.exists()

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        feed_bytes = (data_dir / "feed.json").read_bytes()
        expected_sha = hashlib.sha256(feed_bytes).hexdigest()

        assert meta["sha256"] == expected_sha
        assert meta["count"] == 1

    async def test_meta_not_written_when_no_changes(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        _write_registry(registry_path, [])

        await run_pipeline(
            dry_run=True,
            registry_path=registry_path,
            data_dir=data_dir,
            skip_simplify=True,
        )

        meta_path = data_dir / "meta.json"
        assert not meta_path.exists()


@pytest.mark.asyncio()
class TestPipelineStateTracking:
    async def test_run_count_increments(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, [])

        _seed_state(data_dir / "state.json", run_count=5)

        await run_pipeline(
            dry_run=True,
            registry_path=registry_path,
            data_dir=data_dir,
            skip_simplify=True,
        )

        state = load_state(data_dir / "state.json")
        assert state.run_count == 6

    async def test_dry_run_skips_git(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(
            slug="acme", name="Acme", source_type="lever",
            board_token="acme",
        )
        _write_registry(registry_path, [company])

        posts = _lever_postings("acme")
        adapter = _FakeAdapter(posts)

        with (
            patch("poller.main.get_adapter", return_value=adapter),
            patch("poller.main._git_commit_push") as mock_git,
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )
            mock_git.assert_not_called()


@pytest.mark.asyncio()
class TestStaleSourcePruning:
    async def test_stale_sources_removed_from_state(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(
            slug="alpha", name="Alpha", source_type="greenhouse",
            board_token="alpha",
        )
        _write_registry(registry_path, [company])

        _seed_state(
            data_dir / "state.json",
            sources={
                "greenhouse:alpha": make_source_health(bootstrapped=True),
                "ashby:removed-co": make_source_health(bootstrapped=True),
                "lever:gone-corp": make_source_health(bootstrapped=True),
            },
        )

        gh_adapter = _FakeAdapter(_greenhouse_postings("alpha"))

        with patch("poller.main.get_adapter", return_value=gh_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
            )

        state = load_state(data_dir / "state.json")
        assert "greenhouse:alpha" in state.sources
        assert "ashby:removed-co" not in state.sources
        assert "lever:gone-corp" not in state.sources

    async def test_simplify_meta_key_preserved(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        _write_registry(registry_path, [])

        _seed_state(
            data_dir / "state.json",
            sources={
                "simplify:__meta__": make_source_health(bootstrapped=True),
                "ashby:removed-co": make_source_health(bootstrapped=True),
            },
        )

        await run_pipeline(
            dry_run=True,
            registry_path=registry_path,
            data_dir=data_dir,
            skip_simplify=True,
        )

        state = load_state(data_dir / "state.json")
        assert "simplify:__meta__" in state.sources
        assert "ashby:removed-co" not in state.sources
