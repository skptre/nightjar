from __future__ import annotations

from poller.diff import DiffResult, compute_diff
from poller.models import Posting, SourceHealth
from poller.store import RunState


def _make_posting(
    pid: str = "abc123",
    company: str = "Acme",
    company_slug: str = "acme",
    title: str = "SWE Intern",
    source: str = "greenhouse",
    source_job_id: str = "100",
    first_seen: str = "2026-09-01T00:00:00Z",
    last_seen: str = "2026-09-01T00:00:00Z",
    closed_at: str | None = None,
) -> Posting:
    return Posting(
        id=pid,
        company=company,
        company_slug=company_slug,
        title=title,
        location="New York, NY",
        locations=["New York, NY"],
        url=f"https://boards.greenhouse.io/{company_slug}/jobs/{source_job_id}",
        source=source,
        source_job_id=source_job_id,
        ats=source,
        posted_at="2026-09-01T00:00:00Z",
        first_seen_at=first_seen,
        last_seen_at=last_seen,
        closed_at=closed_at,
    )


T0 = "2026-09-01T00:00:00Z"
T1 = "2026-09-01T06:00:00Z"
T2 = "2026-09-01T12:00:00Z"
T3 = "2026-09-01T18:00:00Z"
T_8_DAYS_LATER = "2026-09-09T00:00:00Z"
T_6_DAYS_LATER = "2026-09-07T00:00:00Z"


class TestNewPostings:
    def test_detects_new_posting(self) -> None:
        p = _make_posting(pid="new1")
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff([p], {}, state, T1)

        assert "new1" in diff.new_ids
        assert "new1" in feed
        assert feed["new1"].last_seen_at == T1

    def test_continuing_posting_not_new(self) -> None:
        p = _make_posting(pid="exist1")
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids={"exist1"},
        )
        prev_feed = {"exist1": _make_posting(pid="exist1")}

        feed, new_state, diff = compute_diff([p], prev_feed, state, T1)

        assert "exist1" not in diff.new_ids
        assert "exist1" in feed

    def test_multiple_new_postings(self) -> None:
        p1 = _make_posting(pid="new1", source_job_id="1")
        p2 = _make_posting(pid="new2", source_job_id="2")
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff([p1, p2], {}, state, T1)

        assert diff.new_ids == frozenset({"new1", "new2"})


class TestFirstMissAbsentTracking:
    def test_disappeared_enters_absent_tracking(self) -> None:
        p = _make_posting(pid="gone1")
        state = RunState(
            active_ids={"gone1"},
            absent_ids={},
        )
        prev_feed = {"gone1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, T1)

        assert "gone1" in new_state.absent_ids
        assert new_state.absent_ids["gone1"] == T1
        assert "gone1" not in diff.closed_ids

    def test_first_miss_stays_in_feed(self) -> None:
        p = _make_posting(pid="gone1")
        state = RunState(active_ids={"gone1"})
        prev_feed = {"gone1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, T1)

        assert "gone1" in feed
        assert feed["gone1"].closed_at is None

    def test_first_miss_last_seen_not_updated(self) -> None:
        p = _make_posting(pid="gone1", last_seen=T0)
        state = RunState(active_ids={"gone1"})
        prev_feed = {"gone1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, T1)

        assert feed["gone1"].last_seen_at == T0


class TestSecondMissClosing:
    def test_second_miss_sets_closed_at(self) -> None:
        p = _make_posting(pid="gone1")
        state = RunState(
            active_ids=set(),
            absent_ids={"gone1": T1},
        )
        prev_feed = {"gone1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, T2)

        assert "gone1" in diff.closed_ids
        assert feed["gone1"].closed_at == T2

    def test_second_miss_removes_from_absent(self) -> None:
        p = _make_posting(pid="gone1")
        state = RunState(
            active_ids=set(),
            absent_ids={"gone1": T1},
        )
        prev_feed = {"gone1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, T2)

        assert "gone1" not in new_state.absent_ids

    def test_already_closed_not_re_closed(self) -> None:
        p = _make_posting(pid="gone1", closed_at=T1)
        state = RunState(
            active_ids=set(),
            absent_ids={"gone1": T0},
        )
        prev_feed = {"gone1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, T2)

        assert feed["gone1"].closed_at == T1
        assert "gone1" not in diff.closed_ids


class TestReappearance:
    def test_reappeared_removed_from_absent(self) -> None:
        p = _make_posting(pid="back1")
        state = RunState(
            active_ids=set(),
            absent_ids={"back1": T0},
        )
        prev_feed = {"back1": _make_posting(pid="back1")}

        feed, new_state, diff = compute_diff([p], prev_feed, state, T1)

        assert "back1" in diff.reappeared_ids
        assert "back1" not in new_state.absent_ids
        assert "back1" in feed
        assert feed["back1"].closed_at is None

    def test_reappeared_not_treated_as_new(self) -> None:
        p = _make_posting(pid="back1")
        state = RunState(
            active_ids=set(),
            absent_ids={"back1": T0},
            sources={"greenhouse:acme": SourceHealth(bootstrapped=True)},
        )
        prev_feed = {"back1": _make_posting(pid="back1")}

        feed, new_state, diff = compute_diff([p], prev_feed, state, T1)

        assert "back1" not in diff.new_ids
        assert "back1" not in diff.bootstrapped_ids

    def test_reappeared_last_seen_updated(self) -> None:
        p = _make_posting(pid="back1", last_seen=T0)
        state = RunState(
            active_ids=set(),
            absent_ids={"back1": T0},
        )
        prev_feed = {"back1": _make_posting(pid="back1", last_seen=T0)}

        feed, new_state, diff = compute_diff([p], prev_feed, state, T1)

        assert feed["back1"].last_seen_at == T1


class TestBootstrapping:
    def test_first_fetch_suppresses_new_flag(self) -> None:
        p = _make_posting(pid="boot1")
        state = RunState(
            sources={},
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff([p], {}, state, T1)

        assert "boot1" in diff.bootstrapped_ids
        assert "boot1" not in diff.new_ids

    def test_first_fetch_sets_bootstrapped_true(self) -> None:
        p = _make_posting(pid="boot1")
        state = RunState(
            sources={},
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff([p], {}, state, T1)

        key = "greenhouse:acme"
        assert key in new_state.sources
        assert new_state.sources[key].bootstrapped is True

    def test_source_with_bootstrapped_false_treated_as_first_fetch(
        self,
    ) -> None:
        p = _make_posting(pid="boot1")
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=False),
            },
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff([p], {}, state, T1)

        assert "boot1" in diff.bootstrapped_ids
        assert "boot1" not in diff.new_ids

    def test_bootstrapped_source_allows_genuine_new(self) -> None:
        p = _make_posting(pid="new1")
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff([p], {}, state, T1)

        assert "new1" in diff.new_ids
        assert "new1" not in diff.bootstrapped_ids

    def test_bootstrapping_does_not_mutate_original_state(self) -> None:
        p = _make_posting(pid="boot1")
        original_health = SourceHealth(bootstrapped=False)
        state = RunState(
            sources={"greenhouse:acme": original_health},
            active_ids=set(),
        )

        compute_diff([p], {}, state, T1)

        assert original_health.bootstrapped is False

    def test_mixed_bootstrapped_and_new(self) -> None:
        p_boot = _make_posting(
            pid="boot1",
            company_slug="newco",
            source_job_id="1",
        )
        p_new = _make_posting(
            pid="new1",
            company_slug="oldco",
            source_job_id="2",
        )
        state = RunState(
            sources={
                "greenhouse:oldco": SourceHealth(bootstrapped=True),
            },
            active_ids=set(),
        )

        feed, new_state, diff = compute_diff(
            [p_boot, p_new], {}, state, T1,
        )

        assert "boot1" in diff.bootstrapped_ids
        assert "new1" in diff.new_ids
        assert "boot1" not in diff.new_ids
        assert "new1" not in diff.bootstrapped_ids


class TestClosedRetention:
    def test_closed_within_7_days_kept(self) -> None:
        p = _make_posting(pid="old1", closed_at=T0)
        state = RunState(active_ids=set())
        prev_feed = {"old1": p}

        feed, new_state, diff = compute_diff(
            [], prev_feed, state, T_6_DAYS_LATER,
        )

        assert "old1" in feed
        assert "old1" not in diff.expired_ids

    def test_closed_past_7_days_expired(self) -> None:
        p = _make_posting(pid="old1", closed_at=T0)
        state = RunState(active_ids=set())
        prev_feed = {"old1": p}

        feed, new_state, diff = compute_diff(
            [], prev_feed, state, T_8_DAYS_LATER,
        )

        assert "old1" not in feed
        assert "old1" in diff.expired_ids

    def test_closed_exactly_7_days_kept(self) -> None:
        closed = "2026-09-01T00:00:00Z"
        now = "2026-09-08T00:00:00Z"
        p = _make_posting(pid="old1", closed_at=closed)
        state = RunState(active_ids=set())
        prev_feed = {"old1": p}

        feed, new_state, diff = compute_diff([], prev_feed, state, now)

        assert "old1" in feed
        assert "old1" not in diff.expired_ids


class TestLastSeenAtUpdates:
    def test_active_posting_last_seen_updated(self) -> None:
        p = _make_posting(pid="a1", last_seen=T0)
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids={"a1"},
        )
        prev_feed = {"a1": _make_posting(pid="a1", last_seen=T0)}

        feed, new_state, diff = compute_diff([p], prev_feed, state, T2)

        assert feed["a1"].last_seen_at == T2

    def test_absent_posting_last_seen_not_updated(self) -> None:
        state = RunState(
            active_ids={"a1"},
        )
        prev_feed = {
            "a1": _make_posting(pid="a1", last_seen=T0),
        }

        feed, new_state, diff = compute_diff([], prev_feed, state, T2)

        assert feed["a1"].last_seen_at == T0


class TestIdempotency:
    def test_identical_input_produces_no_changes(self) -> None:
        p1 = _make_posting(pid="a1", source_job_id="1")
        p2 = _make_posting(pid="b2", source_job_id="2")
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids={"a1", "b2"},
        )
        prev_feed = {
            "a1": _make_posting(pid="a1", source_job_id="1"),
            "b2": _make_posting(pid="b2", source_job_id="2"),
        }

        feed, new_state, diff = compute_diff(
            [p1, p2], prev_feed, state, T1,
        )

        assert diff.new_ids == frozenset()
        assert diff.closed_ids == frozenset()
        assert diff.expired_ids == frozenset()
        assert diff.bootstrapped_ids == frozenset()
        assert not diff.has_changes

    def test_second_run_no_upstream_changes(self) -> None:
        p1 = _make_posting(pid="a1", source_job_id="1")
        p2 = _make_posting(pid="b2", source_job_id="2")

        state0 = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
        )

        feed1, state1, diff1 = compute_diff(
            [p1, p2], {}, state0, T0,
        )

        assert diff1.has_changes

        feed2, state2, diff2 = compute_diff(
            [p1, p2], feed1, state1, T1,
        )

        assert not diff2.has_changes
        assert diff2.new_ids == frozenset()
        assert diff2.closed_ids == frozenset()


class TestStateUpdates:
    def test_run_count_incremented(self) -> None:
        state = RunState(run_count=5)
        feed, new_state, diff = compute_diff([], {}, state, T1)
        assert new_state.run_count == 6

    def test_last_run_at_updated(self) -> None:
        state = RunState(last_run_at=T0)
        feed, new_state, diff = compute_diff([], {}, state, T1)
        assert new_state.last_run_at == T1

    def test_active_ids_reflect_current_run(self) -> None:
        p = _make_posting(pid="a1")
        state = RunState(active_ids={"old_id"})
        feed, new_state, diff = compute_diff([p], {}, state, T1)
        assert new_state.active_ids == {"a1"}

    def test_sources_preserved(self) -> None:
        state = RunState(
            sources={
                "lever:beta": SourceHealth(
                    last_polled_at=T0,
                    healthy=False,
                    error="timeout",
                ),
            },
        )
        feed, new_state, diff = compute_diff([], {}, state, T1)
        assert "lever:beta" in new_state.sources
        assert new_state.sources["lever:beta"].error == "timeout"


class TestDiffHasChanges:
    def test_new_ids_is_change(self) -> None:
        diff = DiffResult(new_ids=frozenset({"x"}))
        assert diff.has_changes

    def test_bootstrapped_ids_is_change(self) -> None:
        diff = DiffResult(bootstrapped_ids=frozenset({"x"}))
        assert diff.has_changes

    def test_closed_ids_is_change(self) -> None:
        diff = DiffResult(closed_ids=frozenset({"x"}))
        assert diff.has_changes

    def test_expired_ids_is_change(self) -> None:
        diff = DiffResult(expired_ids=frozenset({"x"}))
        assert diff.has_changes

    def test_reappeared_only_is_not_change(self) -> None:
        diff = DiffResult(reappeared_ids=frozenset({"x"}))
        assert not diff.has_changes

    def test_empty_is_not_change(self) -> None:
        diff = DiffResult()
        assert not diff.has_changes


class TestMixedScenario:
    def test_simultaneous_new_closed_expired_reappeared(self) -> None:
        p_continuing = _make_posting(pid="cont1", source_job_id="1")
        p_new = _make_posting(pid="new1", source_job_id="2")
        p_reappear = _make_posting(pid="back1", source_job_id="3")

        closed_long_ago = _make_posting(
            pid="expired1",
            source_job_id="4",
            closed_at="2026-08-20T00:00:00Z",
        )
        closed_recently = _make_posting(
            pid="recent_close1",
            source_job_id="5",
            closed_at="2026-08-30T00:00:00Z",
        )
        gone_first_miss = _make_posting(pid="miss1", source_job_id="6")
        gone_second_miss = _make_posting(pid="miss2", source_job_id="7")

        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids={"cont1", "miss1"},
            absent_ids={"miss2": T0, "back1": T0},
        )
        prev_feed = {
            "cont1": p_continuing,
            "miss1": gone_first_miss,
            "miss2": gone_second_miss,
            "back1": _make_posting(pid="back1", source_job_id="3"),
            "expired1": closed_long_ago,
            "recent_close1": closed_recently,
        }

        feed, new_state, diff = compute_diff(
            [p_continuing, p_new, p_reappear],
            prev_feed,
            state,
            T1,
        )

        assert "new1" in diff.new_ids
        assert "miss2" in diff.closed_ids
        assert "back1" in diff.reappeared_ids
        assert "expired1" in diff.expired_ids
        assert diff.has_changes

        assert "cont1" in feed
        assert "new1" in feed
        assert "back1" in feed
        assert "miss1" in feed
        assert "miss2" in feed
        assert "recent_close1" in feed
        assert "expired1" not in feed

        assert feed["miss2"].closed_at == T1
        assert feed["miss1"].closed_at is None
        assert feed["cont1"].last_seen_at == T1
        assert feed["new1"].last_seen_at == T1

        assert new_state.active_ids == {"cont1", "new1", "back1"}
        assert "miss1" in new_state.absent_ids
        assert "miss2" not in new_state.absent_ids
        assert "back1" not in new_state.absent_ids


class TestEmptyFeedFirstRun:
    def test_first_run_empty_state_empty_input(self) -> None:
        state = RunState()
        feed, new_state, diff = compute_diff([], {}, state, T0)

        assert feed == {}
        assert not diff.has_changes
        assert new_state.run_count == 1
        assert new_state.last_run_at == T0

    def test_first_run_with_postings_bootstraps(self) -> None:
        p1 = _make_posting(pid="a1", source_job_id="1")
        p2 = _make_posting(pid="b2", source_job_id="2")
        state = RunState()

        feed, new_state, diff = compute_diff([p1, p2], {}, state, T0)

        assert diff.bootstrapped_ids == frozenset({"a1", "b2"})
        assert diff.new_ids == frozenset()
        assert diff.has_changes
        assert len(feed) == 2
        assert new_state.sources["greenhouse:acme"].bootstrapped is True


class TestReopenedPosting:
    def test_closed_posting_reappears_as_new(self) -> None:
        p = _make_posting(pid="reopen1")
        prev = _make_posting(pid="reopen1", closed_at=T0)
        state = RunState(
            sources={
                "greenhouse:acme": SourceHealth(bootstrapped=True),
            },
            active_ids=set(),
            absent_ids={},
        )
        prev_feed = {"reopen1": prev}

        feed, new_state, diff = compute_diff([p], prev_feed, state, T1)

        assert "reopen1" in feed
        assert feed["reopen1"].closed_at is None
        assert feed["reopen1"].last_seen_at == T1
        assert "reopen1" in diff.new_ids
