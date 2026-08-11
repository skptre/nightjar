from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import UTC, datetime

from poller.models import Posting, SourceHealth
from poller.store import RunState

CLOSED_RETENTION_DAYS = 7


@dataclass(frozen=True)
class DiffResult:
    new_ids: frozenset[str] = field(default_factory=frozenset)
    closed_ids: frozenset[str] = field(default_factory=frozenset)
    reappeared_ids: frozenset[str] = field(default_factory=frozenset)
    bootstrapped_ids: frozenset[str] = field(default_factory=frozenset)
    expired_ids: frozenset[str] = field(default_factory=frozenset)

    @property
    def has_changes(self) -> bool:
        return bool(
            self.new_ids
            or self.bootstrapped_ids
            or self.closed_ids
            or self.expired_ids
        )


def _source_key(posting: Posting) -> str:
    return f"{posting.source}:{posting.company_slug}"


def _parse_iso(ts: str) -> datetime:
    if ts.endswith("Z"):
        return datetime.fromisoformat(ts[:-1]).replace(tzinfo=UTC)
    return datetime.fromisoformat(ts)


def _days_since(closed_at: str, now: str) -> float:
    dt_closed = _parse_iso(closed_at)
    dt_now = _parse_iso(now)
    return (dt_now - dt_closed).total_seconds() / 86400.0


def compute_diff(
    current_postings: list[Posting],
    previous_feed: dict[str, Posting],
    state: RunState,
    now: str,
) -> tuple[dict[str, Posting], RunState, DiffResult]:
    current_by_id: dict[str, Posting] = {p.id: p for p in current_postings}
    current_ids = set(current_by_id.keys())

    previously_active = set(state.active_ids)
    previously_absent = dict(state.absent_ids)

    # --- Detect changes ---

    disappeared_ids = previously_active - current_ids

    still_absent_ids = set(previously_absent.keys()) - current_ids

    reappeared_ids = set(previously_absent.keys()) & current_ids

    raw_new_ids = (
        current_ids - previously_active - set(previously_absent.keys())
    )

    # --- Bootstrapping ---
    bootstrapped_ids: set[str] = set()
    newly_bootstrapped_keys: set[str] = set()

    for pid in raw_new_ids:
        posting = current_by_id[pid]
        key = _source_key(posting)
        source_health = state.sources.get(key)
        if source_health is None or not source_health.bootstrapped:
            bootstrapped_ids.add(pid)
            newly_bootstrapped_keys.add(key)

    genuine_new_ids = raw_new_ids - bootstrapped_ids

    # --- Build updated feed ---
    updated_feed: dict[str, Posting] = {}

    for pid, posting in current_by_id.items():
        updated_feed[pid] = dataclasses.replace(posting, last_seen_at=now)

    for pid in disappeared_ids:
        if pid in previous_feed:
            updated_feed[pid] = previous_feed[pid]

    closed_ids: set[str] = set()
    for pid in still_absent_ids:
        if pid in previous_feed:
            posting = previous_feed[pid]
            if posting.closed_at is None:
                posting = dataclasses.replace(posting, closed_at=now)
                closed_ids.add(pid)
            updated_feed[pid] = posting

    expired_ids: set[str] = set()
    for pid, posting in previous_feed.items():
        if pid in updated_feed:
            continue
        if posting.closed_at is not None:
            days = _days_since(posting.closed_at, now)
            if days <= CLOSED_RETENTION_DAYS:
                updated_feed[pid] = posting
            else:
                expired_ids.add(pid)

    # --- Build updated state ---
    new_absent: dict[str, str] = {}
    for pid in disappeared_ids:
        new_absent[pid] = now

    sources_copy: dict[str, SourceHealth] = {
        k: dataclasses.replace(v) for k, v in state.sources.items()
    }

    for key in newly_bootstrapped_keys:
        if key in sources_copy:
            sources_copy[key].bootstrapped = True
        else:
            sources_copy[key] = SourceHealth(bootstrapped=True)

    updated_state = RunState(
        last_run_at=now,
        run_count=state.run_count + 1,
        sources=sources_copy,
        active_ids=current_ids,
        absent_ids=new_absent,
    )

    diff_result = DiffResult(
        new_ids=frozenset(genuine_new_ids),
        closed_ids=frozenset(closed_ids),
        reappeared_ids=frozenset(reappeared_ids),
        bootstrapped_ids=frozenset(bootstrapped_ids),
        expired_ids=frozenset(expired_ids),
    )

    return updated_feed, updated_state, diff_result
