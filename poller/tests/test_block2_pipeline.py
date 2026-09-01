from __future__ import annotations

import dataclasses
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import yaml

from poller.exceptions import SourceFetchError
from poller.hot_watch import HotWatch, poll_active_watches, save_overrides
from poller.main import run_pipeline
from poller.models import Company, Posting, RawPosting, SourceConfig, SourceHealth
from poller.store import RunState, load_feed, load_state, save_feed, save_state
from poller.tests.conftest import make_posting

NOW = datetime(2026, 9, 1, 16, 0, tzinfo=UTC)


def _companies() -> list[Company]:
    return [
        Company(
            slug="alpha",
            name="Alpha",
            tags=["tech"],
            sources=[SourceConfig(type="greenhouse", board_token="alpha")],
        ),
        Company(
            slug="beta",
            name="Beta",
            tags=["tech"],
            sources=[SourceConfig(type="lever", board_token="beta")],
        ),
    ]


def _write_registry(path: Path, companies: list[Company]) -> None:
    path.write_text(
        yaml.safe_dump(
            [
                {
                    "slug": company.slug,
                    "name": company.name,
                    "tags": company.tags,
                    "sources": [
                        {"type": source.type, "board_token": source.board_token}
                        for source in company.sources
                    ],
                }
                for company in companies
            ],
            sort_keys=False,
        ),
        encoding="utf-8",
    )


class _Adapter:
    def __init__(self, postings: dict[str, list[Posting]], *, fail: bool = False) -> None:
        self.postings = postings
        self.fail = fail
        self.calls: list[str] = []
        self.potentially_truncated = False

    async def fetch(
        self, client: Any, company: Company, source: SourceConfig,
    ) -> list[RawPosting]:
        self.calls.append(company.slug)
        if self.fail:
            raise SourceFetchError(source.type, company.slug, "fixture failure")
        return [
            RawPosting(
                source=posting.source,
                company_slug=posting.company_slug,
                source_job_id=posting.source_job_id,
                title=posting.title,
                location=posting.location,
                locations=posting.locations,
                url=posting.url,
                posted_at=posting.posted_at,
                description="fixture",
            )
            for posting in self.postings.get(company.slug, [])
        ]

    def normalize(
        self, raw: RawPosting, company: Company, now: str,
    ) -> Posting:
        posting = next(
            posting
            for posting in self.postings[company.slug]
            if posting.source_job_id == raw.source_job_id
        )
        return dataclasses.replace(posting, first_seen_at=now, last_seen_at=now)


def _seed(data_dir: Path) -> tuple[Posting, Posting]:
    alpha = make_posting(
        pid="alpha-old",
        company="Alpha",
        company_slug="alpha",
        source="greenhouse",
        source_job_id="1",
    )
    beta = make_posting(
        pid="beta-old",
        company="Beta",
        company_slug="beta",
        source="lever",
        source_job_id="2",
    )
    save_feed(
        data_dir / "feed.json",
        {alpha.id: alpha, beta.id: beta},
        "2026-09-01T15:59:00Z",
        companies=_companies(),
    )
    save_state(
        data_dir / "state.json",
        RunState(
            run_count=2,
            sources={
                "greenhouse:alpha": SourceHealth(
                    last_polled_at="2026-09-01T15:59:00Z",
                    healthy=True,
                    bootstrapped=True,
                ),
                "lever:beta": SourceHealth(
                    last_polled_at="2026-09-01T15:59:00Z",
                    healthy=True,
                    bootstrapped=True,
                ),
            },
            active_ids={alpha.id, beta.id},
            http_cache={"https://example.test": {"etag": "abc"}},
        ),
    )
    return alpha, beta


@pytest.mark.asyncio()
class TestFocusedPipeline:
    async def test_force_polls_only_selected_source_and_retains_every_other_source(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, _companies())
        _, beta = _seed(data_dir)
        alpha_new = make_posting(
            pid="alpha-new",
            company="Alpha",
            company_slug="alpha",
            source="greenhouse",
            source_job_id="3",
        )
        adapter = _Adapter({"alpha": [alpha_new], "beta": []})

        with patch("poller.main.get_adapter", return_value=adapter):
            result = await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
                only_source_keys={"greenhouse:alpha"},
                force_poll=True,
                now=NOW,
            )

        feed = load_feed(data_dir / "feed.json")
        assert adapter.calls == ["alpha"]
        assert beta.id in feed
        assert alpha_new.id in feed
        assert result.attempted_keys == frozenset({"greenhouse:alpha"})
        assert result.successful_keys == frozenset({"greenhouse:alpha"})
        assert result.failed_keys == frozenset()

    async def test_failed_focused_fetch_retains_previous_postings(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, _companies())
        alpha, beta = _seed(data_dir)
        adapter = _Adapter({}, fail=True)

        with patch("poller.main.get_adapter", return_value=adapter):
            result = await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
                only_source_keys={"greenhouse:alpha"},
                force_poll=True,
                now=NOW,
            )

        feed = load_feed(data_dir / "feed.json")
        assert set(feed) == {alpha.id, beta.id}
        assert result.failed_keys == frozenset({"greenhouse:alpha"})
        assert load_state(data_dir / "state.json").sources[
            "greenhouse:alpha"
        ].healthy is False

    async def test_focused_run_preserves_block0_cache_and_watch_stats(
        self, tmp_path: Path,
    ) -> None:
        from poller.models import HotWatchStats

        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        _write_registry(registry_path, _companies())
        _seed(data_dir)
        state = load_state(data_dir / "state.json")
        state.hot_watch_stats["greenhouse:alpha"] = HotWatchStats(
            watch_started_at="2026-09-01T15:00:00Z",
            watch_expires_at="2026-09-02T15:00:00Z",
            requested_interval_minutes=5,
            effective_interval_minutes=5,
        )
        save_state(data_dir / "state.json", state)
        adapter = _Adapter({"alpha": []})

        with patch("poller.main.get_adapter", return_value=adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
                skip_simplify=True,
                only_source_keys={"greenhouse:alpha"},
                force_poll=True,
                now=NOW,
            )

        restored = load_state(data_dir / "state.json")
        assert restored.http_cache == {"https://example.test": {"etag": "abc"}}
        assert "greenhouse:alpha" in restored.hot_watch_stats


@pytest.mark.asyncio()
class TestManagedWatchCycle:
    def _watch(self) -> HotWatch:
        return HotWatch(
            company_slug="alpha",
            source_type="greenhouse",
            interval_minutes=5,
            starts_at=datetime(2026, 9, 1, 15, 0, tzinfo=UTC),
            expires_at=datetime(2026, 9, 2, 15, 0, tzinfo=UTC),
            reason="fixture launch",
        )

    def _setup(self, tmp_path: Path) -> tuple[Path, Path, Path]:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        override_path = tmp_path / "polling-overrides.yaml"
        _write_registry(registry_path, _companies())
        _seed(data_dir)
        state = load_state(data_dir / "state.json")
        state.sources["greenhouse:alpha"].last_polled_at = "2026-09-01T15:50:00Z"
        save_state(data_dir / "state.json", state)
        save_overrides(override_path, [self._watch()])
        return data_dir, registry_path, override_path

    async def test_due_watch_polls_and_records_new_postings(self, tmp_path: Path) -> None:
        data_dir, registry_path, override_path = self._setup(tmp_path)
        new_posting = make_posting(
            pid="alpha-launch",
            company="Alpha",
            company_slug="alpha",
            source="greenhouse",
            source_job_id="launch",
        )
        adapter = _Adapter({"alpha": [new_posting]})

        with patch("poller.main.get_adapter", return_value=adapter):
            result = await poll_active_watches(
                overrides_path=override_path,
                registry_path=registry_path,
                data_dir=data_dir,
                now=NOW,
            )

        state = load_state(data_dir / "state.json")
        stats = state.hot_watch_stats["greenhouse:alpha"]
        assert result.successful_keys == frozenset({"greenhouse:alpha"})
        assert stats.successful_polls == 1
        assert stats.changes_found == 1
        assert stats.last_change_at == "2026-09-01T16:00:00Z"
        assert new_posting.id in load_feed(data_dir / "feed.json")

    async def test_third_failed_cycle_alerts_without_erasing_feed(
        self, tmp_path: Path,
    ) -> None:
        data_dir, registry_path, override_path = self._setup(tmp_path)
        original_ids = set(load_feed(data_dir / "feed.json"))
        adapter = _Adapter({}, fail=True)

        with patch("poller.main.get_adapter", return_value=adapter):
            results = [
                await poll_active_watches(
                    overrides_path=override_path,
                    registry_path=registry_path,
                    data_dir=data_dir,
                    now=NOW + timedelta(minutes=5 * cycle),
                )
                for cycle in range(3)
            ]

        state = load_state(data_dir / "state.json")
        stats = state.hot_watch_stats["greenhouse:alpha"]
        assert stats.consecutive_failures == 3
        assert stats.healthy is False
        assert results[-1].unhealthy_keys == frozenset({"greenhouse:alpha"})
        assert set(load_feed(data_dir / "feed.json")) == original_ids


def test_hot_watch_workflows_are_serialized_and_focused() -> None:
    poll = Path(".github/workflows/hot-watch-poll.yml").read_text(encoding="utf-8")
    control = Path(".github/workflows/hot-watch-control.yml").read_text(encoding="utf-8")

    for workflow in (poll, control):
        assert "group: poller" in workflow
        assert "cancel-in-progress: false" in workflow
    assert 'cron: "*/5 * * * *"' in poll
    assert "poller.tools.hot_watch poll" in poll
    assert "poller.tools.hot_watch" in control
