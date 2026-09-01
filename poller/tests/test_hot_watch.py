from __future__ import annotations

import dataclasses
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest
import yaml

from poller.hot_watch import (
    HotWatch,
    HotWatchConfigError,
    active_watches,
    disable_watch,
    enable_watch,
    is_watch_due,
    load_overrides,
    poll_once_local,
    record_watch_result,
    require_recent_baseline,
)
from poller.models import (
    Company,
    HotWatchStats,
    Posting,
    RawPosting,
    SourceConfig,
    SourceHealth,
)
from poller.store import RunState, load_state, save_state

if TYPE_CHECKING:
    from pathlib import Path

NOW = datetime(2026, 9, 1, 16, 0, tzinfo=UTC)


def _company(
    slug: str = "google",
    *source_types: str,
) -> Company:
    types = source_types or ("greenhouse",)
    return Company(
        slug=slug,
        name=slug.title(),
        tags=["tech"],
        sources=[
            SourceConfig(type=source_type, board_token=f"{slug}-{source_type}")
            for source_type in types
        ],
    )


def _watch(
    *,
    company_slug: str = "google",
    source_type: str = "greenhouse",
    interval_minutes: int = 5,
    starts_at: datetime = NOW - timedelta(minutes=10),
    expires_at: datetime = NOW + timedelta(days=2),
    reason: str = "expected internship launch",
) -> HotWatch:
    return HotWatch(
        company_slug=company_slug,
        source_type=source_type,
        interval_minutes=interval_minutes,
        starts_at=starts_at,
        expires_at=expires_at,
        reason=reason,
    )


def _write_overrides(path: Path, entries: list[dict[str, object]]) -> None:
    path.write_text(
        yaml.safe_dump({"hot_watches": entries}, sort_keys=False),
        encoding="utf-8",
    )


class TestOverrideConfiguration:
    def test_missing_file_loads_as_empty(self, tmp_path: Path) -> None:
        config = load_overrides(
            tmp_path / "missing.yaml", [_company()], now=NOW
        )
        assert config.watches == ()
        assert config.expired == ()

    def test_valid_watch_is_loaded_and_active(self, tmp_path: Path) -> None:
        path = tmp_path / "polling-overrides.yaml"
        _write_overrides(
            path,
            [
                {
                    "company_slug": "google",
                    "source_type": "greenhouse",
                    "interval_minutes": 5,
                    "starts_at": "2026-09-01T15:00:00Z",
                    "expires_at": "2026-09-03T16:00:00Z",
                    "reason": "expected internship launch",
                }
            ],
        )

        config = load_overrides(path, [_company()], now=NOW)

        assert config.watches == (_watch(starts_at=datetime(2026, 9, 1, 15, tzinfo=UTC)),)
        assert active_watches(config, NOW) == config.watches

    @pytest.mark.parametrize(
        ("field", "value", "message"),
        [
            ("interval_minutes", 4, "at least 5"),
            ("interval_minutes", 0, "at least 5"),
            ("interval_minutes", -1, "at least 5"),
            ("company_slug", "unknown", "unknown company"),
            ("source_type", "lever", "does not have source"),
            ("reason", "", "reason"),
        ],
    )
    def test_invalid_watch_is_rejected(
        self,
        tmp_path: Path,
        field: str,
        value: object,
        message: str,
    ) -> None:
        path = tmp_path / "polling-overrides.yaml"
        entry: dict[str, object] = {
            "company_slug": "google",
            "source_type": "greenhouse",
            "interval_minutes": 5,
            "starts_at": "2026-09-01T15:00:00Z",
            "expires_at": "2026-09-03T16:00:00Z",
            "reason": "expected internship launch",
        }
        entry[field] = value
        _write_overrides(path, [entry])

        with pytest.raises(HotWatchConfigError, match=message):
            load_overrides(path, [_company()], now=NOW)

    def test_duration_over_seven_days_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "polling-overrides.yaml"
        _write_overrides(
            path,
            [
                {
                    "company_slug": "google",
                    "source_type": "greenhouse",
                    "interval_minutes": 5,
                    "starts_at": "2026-09-01T15:00:00Z",
                    "expires_at": "2026-09-09T15:00:01Z",
                    "reason": "too long",
                }
            ],
        )

        with pytest.raises(HotWatchConfigError, match="7 days"):
            load_overrides(path, [_company()], now=NOW)

    def test_expired_entry_is_reported_but_never_active(self, tmp_path: Path) -> None:
        path = tmp_path / "polling-overrides.yaml"
        _write_overrides(
            path,
            [
                {
                    "company_slug": "google",
                    "source_type": "greenhouse",
                    "interval_minutes": 5,
                    "starts_at": "2026-08-30T00:00:00Z",
                    "expires_at": "2026-09-01T15:59:59Z",
                    "reason": "finished watch",
                }
            ],
        )

        config = load_overrides(path, [_company()], now=NOW)

        assert config.watches == ()
        assert len(config.expired) == 1
        assert active_watches(config, NOW) == ()

    def test_duplicate_watches_coalesce_to_shortest_interval_and_earliest_expiry(
        self, tmp_path: Path,
    ) -> None:
        path = tmp_path / "polling-overrides.yaml"
        _write_overrides(
            path,
            [
                {
                    "company_slug": "google",
                    "source_type": "greenhouse",
                    "interval_minutes": 15,
                    "starts_at": "2026-09-01T14:00:00Z",
                    "expires_at": "2026-09-05T00:00:00Z",
                    "reason": "first",
                },
                {
                    "company_slug": "google",
                    "source_type": "greenhouse",
                    "interval_minutes": 5,
                    "starts_at": "2026-09-01T15:00:00Z",
                    "expires_at": "2026-09-03T00:00:00Z",
                    "reason": "second",
                },
            ],
        )

        watch = load_overrides(path, [_company()], now=NOW).watches[0]

        assert watch.interval_minutes == 5
        assert watch.starts_at == datetime(2026, 9, 1, 14, tzinfo=UTC)
        assert watch.expires_at == datetime(2026, 9, 3, tzinfo=UTC)
        assert watch.reason == "first; second"


class TestWatchSchedulingAndBaseline:
    def test_new_source_is_due(self) -> None:
        assert is_watch_due(_watch(), None, NOW) is True

    def test_interval_boundary_is_due(self) -> None:
        health = SourceHealth(last_polled_at="2026-09-01T15:55:00Z")
        assert is_watch_due(_watch(), health, NOW) is True

    def test_source_polled_inside_interval_is_not_due(self) -> None:
        health = SourceHealth(last_polled_at="2026-09-01T15:56:00Z")
        assert is_watch_due(_watch(), health, NOW) is False

    def test_future_and_expired_watches_are_not_due(self) -> None:
        assert is_watch_due(
            _watch(starts_at=NOW + timedelta(minutes=1)), None, NOW
        ) is False
        assert is_watch_due(
            _watch(expires_at=NOW - timedelta(seconds=1)), None, NOW
        ) is False

    def test_recent_healthy_bootstrapped_baseline_is_accepted(self) -> None:
        state = RunState(
            sources={
                "greenhouse:google": SourceHealth(
                    last_polled_at="2026-09-01T15:00:00Z",
                    healthy=True,
                    bootstrapped=True,
                )
            }
        )

        require_recent_baseline(state, "greenhouse:google", NOW)

    @pytest.mark.parametrize(
        "health",
        [
            None,
            SourceHealth(last_polled_at=None, healthy=True, bootstrapped=True),
            SourceHealth(
                last_polled_at="2026-09-01T15:00:00Z",
                healthy=False,
                bootstrapped=True,
            ),
            SourceHealth(
                last_polled_at="2026-09-01T15:00:00Z",
                healthy=True,
                bootstrapped=False,
            ),
            SourceHealth(
                last_polled_at="2026-08-30T15:00:00Z",
                healthy=True,
                bootstrapped=True,
            ),
        ],
    )
    def test_missing_failed_unbootstrapped_or_stale_baseline_is_rejected(
        self, health: SourceHealth | None,
    ) -> None:
        state = RunState(
            sources={} if health is None else {"greenhouse:google": health}
        )

        with pytest.raises(HotWatchConfigError, match="baseline"):
            require_recent_baseline(state, "greenhouse:google", NOW)


class TestWatchMutation:
    def _state(self) -> RunState:
        return RunState(
            sources={
                "greenhouse:google": SourceHealth(
                    last_polled_at="2026-09-01T15:00:00Z",
                    healthy=True,
                    bootstrapped=True,
                )
            }
        )

    def test_enable_writes_a_bounded_watch_after_baseline(self, tmp_path: Path) -> None:
        path = tmp_path / "polling-overrides.yaml"

        watch = enable_watch(
            path,
            [_company()],
            self._state(),
            company_slug="google",
            source_type=None,
            interval_minutes=5,
            duration=timedelta(hours=48),
            reason="expected internship launch",
            now=NOW,
        )

        assert watch.key == "greenhouse:google"
        written = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert written["hot_watches"][0]["expires_at"] == "2026-09-03T16:00:00Z"

    def test_enable_dry_run_does_not_write(self, tmp_path: Path) -> None:
        path = tmp_path / "polling-overrides.yaml"

        enable_watch(
            path,
            [_company()],
            self._state(),
            company_slug="google",
            source_type="greenhouse",
            interval_minutes=5,
            duration=timedelta(hours=2),
            reason="dry run",
            now=NOW,
            dry_run=True,
        )

        assert not path.exists()

    def test_enable_rejects_ambiguous_company_source(self, tmp_path: Path) -> None:
        with pytest.raises(HotWatchConfigError, match="multiple sources"):
            enable_watch(
                tmp_path / "polling-overrides.yaml",
                [_company("multi", "greenhouse", "lever")],
                RunState(),
                company_slug="multi",
                source_type=None,
                interval_minutes=5,
                duration=timedelta(hours=2),
                reason="ambiguous",
                now=NOW,
            )

    def test_disable_removes_only_selected_source(self, tmp_path: Path) -> None:
        path = tmp_path / "polling-overrides.yaml"
        watches = [_watch(), _watch(company_slug="other")]
        from poller.hot_watch import save_overrides

        save_overrides(path, watches)

        removed = disable_watch(
            path,
            [_company(), _company("other")],
            company_slug="google",
            source_type="greenhouse",
            now=NOW,
        )

        assert removed is True
        config = load_overrides(path, [_company(), _company("other")], now=NOW)
        assert [watch.company_slug for watch in config.watches] == ["other"]


class TestWatchObservability:
    def test_stats_round_trip_through_state(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        stats = HotWatchStats(
            watch_started_at="2026-09-01T15:00:00Z",
            watch_expires_at="2026-09-03T15:00:00Z",
            requested_interval_minutes=5,
            effective_interval_minutes=5,
            successful_polls=2,
            failures=1,
            consecutive_failures=0,
            changes_found=3,
            last_change_at="2026-09-01T15:30:00Z",
            request_count=7,
            healthy=True,
        )
        save_state(path, RunState(hot_watch_stats={"greenhouse:google": stats}))

        restored = load_state(path).hot_watch_stats["greenhouse:google"]

        assert restored == stats

    def test_three_consecutive_failures_mark_watch_unhealthy(self) -> None:
        state = RunState()
        watch = _watch()

        for minute in range(3):
            record_watch_result(
                state,
                watch,
                succeeded=False,
                changes_found=0,
                request_count=3,
                now=NOW + timedelta(minutes=minute),
            )

        stats = state.hot_watch_stats[watch.key]
        assert stats.failures == 3
        assert stats.consecutive_failures == 3
        assert stats.request_count == 9
        assert stats.healthy is False

    def test_success_resets_failures_and_records_changes(self) -> None:
        state = RunState()
        watch = _watch()
        record_watch_result(
            state,
            watch,
            succeeded=False,
            changes_found=0,
            request_count=3,
            now=NOW,
        )

        record_watch_result(
            state,
            watch,
            succeeded=True,
            changes_found=2,
            request_count=1,
            now=NOW + timedelta(minutes=5),
        )

        stats = state.hot_watch_stats[watch.key]
        assert stats.successful_polls == 1
        assert stats.failures == 1
        assert stats.consecutive_failures == 0
        assert stats.changes_found == 2
        assert stats.last_change_at == "2026-09-01T16:05:00Z"
        assert stats.healthy is True


@pytest.mark.asyncio()
class TestLocalForegroundWatch:
    async def test_detects_new_stable_ids_without_accepting_storage_paths(self) -> None:
        existing = Posting(
            id="existing",
            company="Google",
            company_slug="google",
            title="Software Engineering Intern",
            location="New York, NY",
            locations=["New York, NY"],
            url="https://example.test/jobs/1",
            source="greenhouse",
            source_job_id="1",
            ats="greenhouse",
            posted_at=None,
            first_seen_at="2026-09-01T15:00:00Z",
            last_seen_at="2026-09-01T15:00:00Z",
        )
        added = dataclasses.replace(
            existing,
            id="added",
            source_job_id="2",
            url="https://example.test/jobs/2",
        )

        class Adapter:
            potentially_truncated = False

            async def fetch(
                self,
                client: Any,
                company: Company,
                source: SourceConfig,
            ) -> list[RawPosting]:
                return [
                    RawPosting(
                        source=posting.source,
                        company_slug=posting.company_slug,
                        source_job_id=posting.source_job_id,
                        title=posting.title,
                        location=posting.location,
                        locations=posting.locations,
                        url=posting.url,
                        posted_at=None,
                        description="fixture",
                    )
                    for posting in (existing, added)
                ]

            def normalize(
                self, raw: RawPosting, company: Company, now: str,
            ) -> Posting:
                return existing if raw.source_job_id == "1" else added

        company = _company()
        source = company.sources[0]
        with patch("poller.hot_watch.get_adapter", return_value=Adapter()):
            result = await poll_once_local(
                company,
                source,
                baseline_ids={"existing"},
                now=NOW,
            )

        assert result.success is True
        assert result.current_ids == frozenset({"existing", "added"})
        assert result.added_ids == frozenset({"added"})

    async def test_failure_is_not_reported_as_empty(self) -> None:
        class FailingAdapter:
            potentially_truncated = False

            async def fetch(
                self,
                client: Any,
                company: Company,
                source: SourceConfig,
            ) -> list[RawPosting]:
                from poller.exceptions import SourceFetchError

                raise SourceFetchError(source.type, company.slug, "blocked")

            def normalize(
                self, raw: RawPosting, company: Company, now: str,
            ) -> Posting:
                raise AssertionError("normalize must not run")

        company = _company()
        with patch("poller.hot_watch.get_adapter", return_value=FailingAdapter()):
            result = await poll_once_local(
                company,
                company.sources[0],
                baseline_ids={"existing"},
                now=NOW,
            )

        assert result.success is False
        assert result.current_ids is None
        assert result.added_ids == frozenset()
        assert result.error == "blocked"
