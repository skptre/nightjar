from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import UTC, datetime

from poller.dedupe import canonicalize_url
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
        return bool(self.new_ids or self.bootstrapped_ids or self.closed_ids or self.expired_ids)


def _source_key(posting: Posting) -> str:
    if posting.source == "simplify":
        return "simplify:__meta__"
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
    *,
    complete_sources: set[str] | None = None,
    observed_ids: set[str] | None = None,
) -> tuple[dict[str, Posting], RunState, DiffResult]:
    # Canonical source preference may change; users' saved posting IDs must not.
    historical: dict[str, str] = {}
    urls: dict[str, str] = {}
    for historical_posting in sorted(previous_feed.values(), key=lambda p: (p.first_seen_at, p.id)):
        for alias in [historical_posting.id, *historical_posting.merged_from]:
            historical.setdefault(alias, historical_posting.id)
        url = canonicalize_url(
            historical_posting.url, provider=historical_posting.ats, has_source_job_id=True
        )
        if url:
            urls.setdefault(url, historical_posting.id)
    remapped: dict[str, str] = {}
    stable: dict[str, Posting] = {}

    # Carried rows must never overwrite a freshly observed alias of that row.
    def observation_priority(posting: Posting) -> int:
        if observed_ids is None or posting.id in observed_ids:
            return 0
        return 1 if set(posting.merged_from) & observed_ids else 2

    ordered = sorted(current_postings, key=observation_priority)
    for posting in ordered:
        url = canonicalize_url(posting.url, provider=posting.ats, has_source_job_id=True)
        target = historical.get(posting.id)
        if target is None:
            target = next((historical[a] for a in posting.merged_from if a in historical), None)
        target = target or urls.get(url) or posting.id
        remapped[posting.id] = target
        previous_aliases = previous_feed[target].merged_from if target in previous_feed else []
        aliases = set(posting.merged_from) | set(previous_aliases) | {posting.id}
        winner = stable.get(target, posting)
        aliases.update(winner.merged_from)
        stable[target] = dataclasses.replace(
            winner, id=target, merged_from=sorted(aliases - {target})
        )
    current_postings = list(stable.values())
    if observed_ids is not None:
        observed_ids = {remapped.get(pid, pid) for pid in observed_ids}
    current_by_id: dict[str, Posting] = {p.id: p for p in current_postings}
    current_ids = set(current_by_id.keys())
    observed = current_ids if observed_ids is None else observed_ids & current_ids

    def may_close(pid: str) -> bool:
        posting = previous_feed.get(pid)
        return complete_sources is None or (
            posting is not None and _source_key(posting) in complete_sources
        )

    previously_active = set(state.active_ids)
    previously_absent = dict(state.absent_ids)

    # --- Detect changes ---

    missing = (previously_active | set(previously_absent)) - observed
    protected_ids = {pid for pid in missing if not may_close(pid)}
    disappeared_ids = (previously_active - observed) - protected_ids

    still_absent_ids = (set(previously_absent) - observed) - protected_ids
    unconfirmed_retries = {
        pid for pid in still_absent_ids if _parse_iso(now) <= _parse_iso(previously_absent[pid])
    }
    still_absent_ids -= unconfirmed_retries
    protected_ids |= unconfirmed_retries

    reappeared_ids = set(previously_absent) & observed

    raw_new_ids = observed - previously_active - set(previously_absent)

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
        previous = previous_feed.get(pid)
        updated_feed[pid] = dataclasses.replace(
            posting,
            first_seen_at=previous.first_seen_at if previous else posting.first_seen_at,
            description_text=(
                posting.description_text or (previous.description_text if previous else "")
            ),
            last_seen_at=now if pid in observed else posting.last_seen_at,
        )

    for pid in disappeared_ids:
        if pid in previous_feed:
            updated_feed[pid] = previous_feed[pid]
    for pid in protected_ids:
        if pid in previous_feed:
            updated_feed.setdefault(pid, previous_feed[pid])

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
    new_absent = {
        pid: absent_at for pid, absent_at in previously_absent.items() if pid in protected_ids
    }
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
        run_duration_seconds=state.run_duration_seconds,
        sources=sources_copy,
        active_ids=(observed | (previously_active & protected_ids)),
        absent_ids=new_absent,
        http_cache=dict(state.http_cache),
        description_attempts={
            key: dict(value) for key, value in state.description_attempts.items()
        },
        hot_watch_stats={
            key: dataclasses.replace(value) for key, value in state.hot_watch_stats.items()
        },
    )

    diff_result = DiffResult(
        new_ids=frozenset(genuine_new_ids),
        closed_ids=frozenset(closed_ids),
        reappeared_ids=frozenset(reappeared_ids),
        bootstrapped_ids=frozenset(bootstrapped_ids),
        expired_ids=frozenset(expired_ids),
    )

    return updated_feed, updated_state, diff_result
