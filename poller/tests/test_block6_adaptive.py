"""Block 6 — Adaptive Polling tests.

TDD tests for data-driven scheduling: activity metrics tracking,
tier classification, adaptive intervals, cost-aware scheduling,
conditional request integration, serialization, and logging.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from poller.models import Company, SourceConfig, SourceHealth
from poller.registry import (
    MIN_ADAPTIVE_POLLS,
    classify_tier_distribution,
    get_activity_tier,
    is_poll_due,
    prioritize_due_sources,
    update_source_activity,
)


def _company(
    *,
    slug: str = "test",
    high_priority: bool = False,
    seasonal_pattern: str | None = None,
    typical_open: str | None = None,
) -> Company:
    return Company(
        slug=slug,
        name="Test Co",
        tags=["tech"],
        sources=[SourceConfig(type="greenhouse", board_token=slug)],
        typical_open=typical_open,
        high_priority=high_priority,
        seasonal_pattern=seasonal_pattern,
    )


def _health(
    now: datetime,
    elapsed: timedelta,
    *,
    consecutive_unchanged: int = 0,
    change_frequency: float = 0.0,
    last_change_at: str | None = None,
    estimated_poll_cost: float = 0.0,
    activity_poll_count: int = 0,
) -> SourceHealth:
    return SourceHealth(
        last_polled_at=(now - elapsed).isoformat(),
        consecutive_unchanged=consecutive_unchanged,
        change_frequency=change_frequency,
        last_change_at=last_change_at,
        estimated_poll_cost=estimated_poll_cost,
        activity_poll_count=activity_poll_count,
    )


# ── Activity Metrics Tracking ────────────────────────────────


class TestUpdateSourceActivity:

    def test_first_poll_with_change(self) -> None:
        health = SourceHealth()
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        updated = update_source_activity(
            health, changed=True, poll_duration=2.5, now=now,
        )
        assert updated.last_change_at == "2026-09-01T12:00:00Z"
        assert updated.consecutive_unchanged == 0
        assert updated.change_frequency == 1.0
        assert updated.estimated_poll_cost == 2.5
        assert updated.activity_poll_count == 1

    def test_first_poll_without_change(self) -> None:
        health = SourceHealth()
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        updated = update_source_activity(
            health, changed=False, poll_duration=1.0, now=now,
        )
        assert updated.last_change_at is None
        assert updated.consecutive_unchanged == 1
        assert updated.change_frequency == 0.0
        assert updated.estimated_poll_cost == 1.0
        assert updated.activity_poll_count == 1

    def test_consecutive_unchanged_increments(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(consecutive_unchanged=5, activity_poll_count=5)
        updated = update_source_activity(
            health, changed=False, poll_duration=1.0, now=now,
        )
        assert updated.consecutive_unchanged == 6

    def test_consecutive_unchanged_resets_on_change(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(consecutive_unchanged=15, activity_poll_count=15)
        updated = update_source_activity(
            health, changed=True, poll_duration=1.0, now=now,
        )
        assert updated.consecutive_unchanged == 0
        assert updated.last_change_at == "2026-09-01T12:00:00Z"

    def test_change_frequency_increases_on_change(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(change_frequency=0.1, activity_poll_count=5)
        updated = update_source_activity(
            health, changed=True, poll_duration=1.0, now=now,
        )
        assert updated.change_frequency > 0.1

    def test_change_frequency_decreases_on_no_change(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(change_frequency=0.5, activity_poll_count=5)
        updated = update_source_activity(
            health, changed=False, poll_duration=1.0, now=now,
        )
        assert updated.change_frequency < 0.5

    def test_estimated_poll_cost_ema_blends(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(estimated_poll_cost=10.0, activity_poll_count=5)
        updated = update_source_activity(
            health, changed=False, poll_duration=2.0, now=now,
        )
        assert 2.0 < updated.estimated_poll_cost < 10.0

    def test_poll_count_always_increments(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(activity_poll_count=7)
        updated = update_source_activity(
            health, changed=True, poll_duration=1.0, now=now,
        )
        assert updated.activity_poll_count == 8

    def test_preserves_existing_health_fields(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(
            last_polled_at="2026-09-01T11:00:00Z",
            healthy=True,
            bootstrapped=True,
            potentially_truncated=True,
        )
        updated = update_source_activity(
            health, changed=False, poll_duration=1.0, now=now,
        )
        assert updated.last_polled_at == "2026-09-01T11:00:00Z"
        assert updated.healthy is True
        assert updated.bootstrapped is True
        assert updated.potentially_truncated is True

    def test_stores_content_hash(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth()
        updated = update_source_activity(
            health, changed=True, poll_duration=1.0, now=now,
            content_hash="abcd1234",
        )
        assert updated.last_content_hash == "abcd1234"

    def test_preserves_content_hash_when_not_provided(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(last_content_hash="existing_hash")
        updated = update_source_activity(
            health, changed=False, poll_duration=1.0, now=now,
        )
        assert updated.last_content_hash == "existing_hash"


# ── Activity Tier Classification ─────────────────────────────


class TestGetActivityTier:

    def test_none_health_returns_none(self) -> None:
        assert get_activity_tier(None) is None

    def test_insufficient_data_returns_none(self) -> None:
        health = SourceHealth(activity_poll_count=3, consecutive_unchanged=0)
        assert get_activity_tier(health) is None

    def test_exactly_min_polls_enables_adaptive(self) -> None:
        health = SourceHealth(
            activity_poll_count=MIN_ADAPTIVE_POLLS, consecutive_unchanged=0,
        )
        assert get_activity_tier(health) is not None

    def test_hot_just_changed(self) -> None:
        health = SourceHealth(activity_poll_count=50, consecutive_unchanged=0)
        assert get_activity_tier(health) == "hot"

    def test_hot_changed_one_ago(self) -> None:
        health = SourceHealth(activity_poll_count=50, consecutive_unchanged=1)
        assert get_activity_tier(health) == "hot"

    def test_active_at_boundary(self) -> None:
        health = SourceHealth(activity_poll_count=50, consecutive_unchanged=2)
        assert get_activity_tier(health) == "active"

    def test_active_upper_bound(self) -> None:
        health = SourceHealth(activity_poll_count=50, consecutive_unchanged=9)
        assert get_activity_tier(health) == "active"

    def test_quiet_at_boundary(self) -> None:
        health = SourceHealth(activity_poll_count=50, consecutive_unchanged=10)
        assert get_activity_tier(health) == "quiet"

    def test_quiet_far_above(self) -> None:
        health = SourceHealth(activity_poll_count=60, consecutive_unchanged=50)
        assert get_activity_tier(health) == "quiet"


# ── Adaptive Intervals in is_poll_due ────────────────────────


class TestAdaptivePolling:

    def test_hot_source_due_at_15_min(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(
            now, timedelta(minutes=16),
            consecutive_unchanged=0, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is True

    def test_hot_source_not_due_before_15_min(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(
            now, timedelta(minutes=14),
            consecutive_unchanged=0, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is False

    def test_active_source_due_at_2h(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(
            now, timedelta(hours=2, minutes=1),
            consecutive_unchanged=5, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is True

    def test_active_source_not_due_before_2h(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(
            now, timedelta(hours=1),
            consecutive_unchanged=5, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is False

    def test_quiet_source_due_at_6h(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(
            now, timedelta(hours=7),
            consecutive_unchanged=15, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is True

    def test_quiet_source_not_due_before_6h(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(
            now, timedelta(hours=5),
            consecutive_unchanged=15, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is False

    def test_new_source_uses_default_interval(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health_not_due = _health(
            now, timedelta(hours=5), activity_poll_count=3,
        )
        assert is_poll_due(company, health_not_due, now) is False

        health_due = _health(
            now, timedelta(hours=7), activity_poll_count=3,
        )
        assert is_poll_due(company, health_due, now) is True


# ── Adaptive Override Priority ───────────────────────────────


class TestAdaptiveOverrides:

    def test_high_priority_caps_active_to_30_min(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company(high_priority=True)
        health = _health(
            now, timedelta(minutes=31),
            consecutive_unchanged=5, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is True

    def test_high_priority_preserves_hot_15_min(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company(high_priority=True)
        health = _health(
            now, timedelta(minutes=16),
            consecutive_unchanged=0, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is True

    def test_high_priority_caps_quiet_to_30_min(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company(high_priority=True)
        due = _health(
            now, timedelta(minutes=31),
            consecutive_unchanged=15, activity_poll_count=50,
        )
        assert is_poll_due(company, due, now) is True

        not_due = _health(
            now, timedelta(minutes=25),
            consecutive_unchanged=15, activity_poll_count=50,
        )
        assert is_poll_due(company, not_due, now) is False

    def test_off_season_caps_hot_to_6h(self) -> None:
        now = datetime(2026, 2, 1, 12, 0, 0, tzinfo=UTC)
        company = _company(seasonal_pattern="fall")
        health = _health(
            now, timedelta(minutes=16),
            consecutive_unchanged=0, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is False

    def test_off_season_overrides_high_priority_adaptive(self) -> None:
        now = datetime(2026, 2, 1, 12, 0, 0, tzinfo=UTC)
        company = _company(seasonal_pattern="fall", high_priority=True)
        not_due = _health(
            now, timedelta(hours=4),
            consecutive_unchanged=5, activity_poll_count=50,
        )
        assert is_poll_due(company, not_due, now) is False

        due = _health(
            now, timedelta(hours=7),
            consecutive_unchanged=5, activity_poll_count=50,
        )
        assert is_poll_due(company, due, now) is True

    def test_ramp_window_overrides_quiet(self) -> None:
        now = datetime(2026, 8, 25, 12, 0, 0, tzinfo=UTC)
        company = _company(typical_open="2026-09")
        health = _health(
            now, timedelta(minutes=5),
            consecutive_unchanged=20, activity_poll_count=50,
        )
        assert is_poll_due(company, health, now) is True

    def test_no_adaptive_data_high_priority_30_min(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company(high_priority=True)
        health = _health(now, timedelta(minutes=31), activity_poll_count=2)
        assert is_poll_due(company, health, now) is True

    def test_no_adaptive_data_normal_6h(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        company = _company()
        health = _health(now, timedelta(hours=5), activity_poll_count=2)
        assert is_poll_due(company, health, now) is False


# ── Conditional Request Integration ──────────────────────────


class TestConditionalRequestIntegration:

    def test_304_increments_unchanged_count(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(consecutive_unchanged=3, activity_poll_count=5)
        updated = update_source_activity(
            health, changed=False, poll_duration=0.1, now=now,
        )
        assert updated.consecutive_unchanged == 4
        assert updated.activity_poll_count == 6

    def test_304_preserves_healthy_status(self) -> None:
        now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
        health = SourceHealth(healthy=True, activity_poll_count=5)
        updated = update_source_activity(
            health, changed=False, poll_duration=0.1, now=now,
        )
        assert updated.healthy is True


# ── Cost-Aware Scheduling ────────────────────────────────────


class TestCostAwareScheduling:

    def test_hot_prioritized_over_quiet(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=5.0,
            ),
            "greenhouse:quiet-co": SourceHealth(
                consecutive_unchanged=15, activity_poll_count=50,
                estimated_poll_cost=30.0,
            ),
        }
        hot = _company(slug="hot-co")
        quiet = _company(slug="quiet-co")
        tasks = [(quiet, quiet.sources[0]), (hot, hot.sources[0])]

        prioritized, _ = prioritize_due_sources(tasks, sources, budget_seconds=900.0)
        assert prioritized[0][0].slug == "hot-co"

    def test_defers_quiet_when_budget_exceeded(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=700.0,
            ),
            "greenhouse:quiet-co": SourceHealth(
                consecutive_unchanged=15, activity_poll_count=50,
                estimated_poll_cost=100.0,
            ),
        }
        hot = _company(slug="hot-co")
        quiet = _company(slug="quiet-co")
        tasks = [(hot, hot.sources[0]), (quiet, quiet.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0,
        )
        deferred_slugs = [t[0].slug for t in deferred]
        assert "quiet-co" in deferred_slugs
        assert "hot-co" not in deferred_slugs

    def test_keeps_all_under_budget(self) -> None:
        sources = {
            "greenhouse:test": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=10.0,
            ),
        }
        company = _company()
        tasks = [(company, company.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0,
        )
        assert len(prioritized) == 1
        assert len(deferred) == 0

    def test_never_defers_hot_or_active(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=800.0,
            ),
            "greenhouse:active-co": SourceHealth(
                consecutive_unchanged=5, activity_poll_count=50,
                estimated_poll_cost=200.0,
            ),
        }
        hot = _company(slug="hot-co")
        active = _company(slug="active-co")
        tasks = [(hot, hot.sources[0]), (active, active.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0,
        )
        assert len(deferred) == 0
        assert len(prioritized) == 2


# ── Serialization Round-Trip ─────────────────────────────────


class TestSourceHealthSerialization:

    def test_new_fields_serialize(self) -> None:
        from poller.store import RunState

        health = SourceHealth(
            last_polled_at="2026-09-01T12:00:00Z",
            healthy=True,
            last_change_at="2026-09-01T11:00:00Z",
            change_frequency=0.35,
            consecutive_unchanged=3,
            estimated_poll_cost=5.2,
            activity_poll_count=12,
            last_content_hash="abc123",
        )
        state = RunState(sources={"greenhouse:test": health})
        d = state.to_dict()

        source_data = d["sources"]["greenhouse:test"]
        assert source_data["last_change_at"] == "2026-09-01T11:00:00Z"
        assert source_data["change_frequency"] == 0.35
        assert source_data["consecutive_unchanged"] == 3
        assert source_data["estimated_poll_cost"] == 5.2
        assert source_data["activity_poll_count"] == 12
        assert source_data["last_content_hash"] == "abc123"

    def test_new_fields_deserialize(self) -> None:
        from poller.store import RunState

        d = {
            "sources": {
                "greenhouse:test": {
                    "last_polled_at": "2026-09-01T12:00:00Z",
                    "healthy": True,
                    "last_change_at": "2026-09-01T11:00:00Z",
                    "change_frequency": 0.35,
                    "consecutive_unchanged": 3,
                    "estimated_poll_cost": 5.2,
                    "activity_poll_count": 12,
                    "last_content_hash": "abc123",
                }
            }
        }
        state = RunState.from_dict(d)
        h = state.sources["greenhouse:test"]

        assert h.last_change_at == "2026-09-01T11:00:00Z"
        assert h.change_frequency == 0.35
        assert h.consecutive_unchanged == 3
        assert h.estimated_poll_cost == 5.2
        assert h.activity_poll_count == 12
        assert h.last_content_hash == "abc123"

    def test_missing_new_fields_default(self) -> None:
        from poller.store import RunState

        d = {
            "sources": {
                "greenhouse:test": {
                    "last_polled_at": "2026-09-01T12:00:00Z",
                    "healthy": True,
                }
            }
        }
        state = RunState.from_dict(d)
        h = state.sources["greenhouse:test"]

        assert h.last_change_at is None
        assert h.change_frequency == 0.0
        assert h.consecutive_unchanged == 0
        assert h.estimated_poll_cost == 0.0
        assert h.activity_poll_count == 0
        assert h.last_content_hash is None

    def test_full_round_trip(self) -> None:
        from poller.store import RunState

        health = SourceHealth(
            last_polled_at="2026-09-01T12:00:00Z",
            healthy=True,
            bootstrapped=True,
            potentially_truncated=False,
            last_change_at="2026-09-01T10:00:00Z",
            change_frequency=0.42,
            consecutive_unchanged=7,
            estimated_poll_cost=8.3,
            activity_poll_count=50,
            last_content_hash="deadbeef12345678",
        )
        state = RunState(sources={"greenhouse:test": health})
        restored = RunState.from_dict(state.to_dict())
        h = restored.sources["greenhouse:test"]

        assert h.last_polled_at == health.last_polled_at
        assert h.healthy == health.healthy
        assert h.bootstrapped == health.bootstrapped
        assert h.last_change_at == health.last_change_at
        assert h.change_frequency == health.change_frequency
        assert h.consecutive_unchanged == health.consecutive_unchanged
        assert h.estimated_poll_cost == health.estimated_poll_cost
        assert h.activity_poll_count == health.activity_poll_count
        assert h.last_content_hash == health.last_content_hash


# ── Tier Distribution Logging ────────────────────────────────


class TestTierDistribution:

    def test_classify_mixed_sources(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
            ),
            "lever:active-co": SourceHealth(
                consecutive_unchanged=5, activity_poll_count=50,
            ),
            "ashby:quiet-co": SourceHealth(
                consecutive_unchanged=15, activity_poll_count=50,
            ),
            "workday:new-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=2,
            ),
        }
        dist = classify_tier_distribution(sources)
        assert dist["hot"] == 1
        assert dist["active"] == 1
        assert dist["quiet"] == 1
        assert dist["unknown"] == 1

    def test_empty_sources(self) -> None:
        dist = classify_tier_distribution({})
        assert dist == {"hot": 0, "active": 0, "quiet": 0, "unknown": 0}


# ── Content Hash Detection (Issue 1) ───────────────────────


class TestContentHashDetection:

    def test_title_edit_changes_hash(self) -> None:
        import hashlib

        def content_hash(postings: list[tuple[str, str, str, str]]) -> str:
            parts = sorted(f"{pid}|{t}|{u}|{loc}" for pid, t, u, loc in postings)
            return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]

        base = [("id1", "SWE Intern", "https://co.com/1", "NYC")]
        edited = [("id1", "Software Engineer Intern", "https://co.com/1", "NYC")]
        assert content_hash(base) != content_hash(edited)

    def test_same_content_same_hash(self) -> None:
        import hashlib

        def content_hash(postings: list[tuple[str, str, str, str]]) -> str:
            parts = sorted(f"{pid}|{t}|{u}|{loc}" for pid, t, u, loc in postings)
            return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]

        data = [("id1", "SWE Intern", "https://co.com/1", "NYC")]
        assert content_hash(data) == content_hash(data)

    def test_url_edit_changes_hash(self) -> None:
        import hashlib

        def content_hash(postings: list[tuple[str, str, str, str]]) -> str:
            parts = sorted(f"{pid}|{t}|{u}|{loc}" for pid, t, u, loc in postings)
            return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]

        base = [("id1", "SWE Intern", "https://co.com/1", "NYC")]
        edited = [("id1", "SWE Intern", "https://co.com/jobs/1", "NYC")]
        assert content_hash(base) != content_hash(edited)


# ── Never-Defer High Priority & Hot-Watch (Issue 2) ────────


class TestNeverDeferProtected:

    def test_high_priority_quiet_never_deferred(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=700.0,
            ),
            "greenhouse:hp-quiet": SourceHealth(
                consecutive_unchanged=15, activity_poll_count=50,
                estimated_poll_cost=200.0,
            ),
        }
        hot = _company(slug="hot-co")
        hp_quiet = _company(slug="hp-quiet", high_priority=True)
        tasks = [(hot, hot.sources[0]), (hp_quiet, hp_quiet.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0,
        )
        deferred_slugs = [t[0].slug for t in deferred]
        assert "hp-quiet" not in deferred_slugs

    def test_hot_watch_key_never_deferred(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=700.0,
            ),
            "greenhouse:watched": SourceHealth(
                consecutive_unchanged=15, activity_poll_count=50,
                estimated_poll_cost=200.0,
            ),
        }
        hot = _company(slug="hot-co")
        watched = _company(slug="watched")
        tasks = [(hot, hot.sources[0]), (watched, watched.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0,
            force_include_keys={"greenhouse:watched"},
        )
        deferred_slugs = [t[0].slug for t in deferred]
        assert "watched" not in deferred_slugs

    def test_unprotected_quiet_still_deferred(self) -> None:
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=700.0,
            ),
            "greenhouse:quiet-co": SourceHealth(
                consecutive_unchanged=15, activity_poll_count=50,
                estimated_poll_cost=200.0,
            ),
        }
        hot = _company(slug="hot-co")
        quiet = _company(slug="quiet-co")
        tasks = [(hot, hot.sources[0]), (quiet, quiet.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0,
        )
        deferred_slugs = [t[0].slug for t in deferred]
        assert "quiet-co" in deferred_slugs


# ── Anti-Starvation (Issue 3) ──────────────────────────────


class TestAntiStarvation:

    def test_starving_quiet_source_not_deferred(self) -> None:
        now = datetime(2026, 9, 3, 12, 0, 0, tzinfo=UTC)
        stale_time = (now - timedelta(hours=50)).isoformat()
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=700.0,
            ),
            "greenhouse:starved": SourceHealth(
                consecutive_unchanged=20, activity_poll_count=50,
                estimated_poll_cost=200.0,
                last_polled_at=stale_time,
            ),
        }
        hot = _company(slug="hot-co")
        starved = _company(slug="starved")
        tasks = [(hot, hot.sources[0]), (starved, starved.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0, now=now,
        )
        deferred_slugs = [t[0].slug for t in deferred]
        assert "starved" not in deferred_slugs

    def test_recently_polled_quiet_can_be_deferred(self) -> None:
        now = datetime(2026, 9, 3, 12, 0, 0, tzinfo=UTC)
        recent_time = (now - timedelta(hours=7)).isoformat()
        sources = {
            "greenhouse:hot-co": SourceHealth(
                consecutive_unchanged=0, activity_poll_count=50,
                estimated_poll_cost=700.0,
            ),
            "greenhouse:recent-quiet": SourceHealth(
                consecutive_unchanged=20, activity_poll_count=50,
                estimated_poll_cost=200.0,
                last_polled_at=recent_time,
            ),
        }
        hot = _company(slug="hot-co")
        recent_quiet = _company(slug="recent-quiet")
        tasks = [(hot, hot.sources[0]), (recent_quiet, recent_quiet.sources[0])]

        prioritized, deferred = prioritize_due_sources(
            tasks, sources, budget_seconds=900.0, now=now,
        )
        deferred_slugs = [t[0].slug for t in deferred]
        assert "recent-quiet" in deferred_slugs
