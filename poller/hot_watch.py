from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import RateLimitedClient
from poller.models import (
    Company,
    HotWatchStats,
    SourceConfig,
    SourceHealth,
)
from poller.registry import load_registry
from poller.sources import get_adapter
from poller.store import RunState, load_feed, load_state, save_state

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OVERRIDES_PATH = ROOT_DIR / "polling-overrides.yaml"
DEFAULT_DATA_DIR = ROOT_DIR / "data"
MANAGED_MIN_INTERVAL_MINUTES = 5
LOCAL_MIN_INTERVAL_MINUTES = 2
MAX_WATCH_DURATION = timedelta(days=7)
MAX_BASELINE_AGE = timedelta(hours=24)


class HotWatchConfigError(ValueError):
    """Raised when a hot-watch request or configuration is unsafe."""


@dataclass(frozen=True)
class HotWatch:
    company_slug: str
    source_type: str
    interval_minutes: int
    starts_at: datetime
    expires_at: datetime
    reason: str

    @property
    def key(self) -> str:
        return f"{self.source_type}:{self.company_slug}"


@dataclass(frozen=True)
class OverrideConfig:
    watches: tuple[HotWatch, ...] = ()
    expired: tuple[HotWatch, ...] = ()


@dataclass(frozen=True)
class LocalPollResult:
    success: bool
    current_ids: frozenset[str] | None
    added_ids: frozenset[str]
    error: str | None = None


@dataclass(frozen=True)
class HotWatchCycleResult:
    active_keys: frozenset[str]
    attempted_keys: frozenset[str]
    successful_keys: frozenset[str]
    failed_keys: frozenset[str]
    unhealthy_keys: frozenset[str]
    expired_keys: frozenset[str]


def format_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_datetime(value: object, field_name: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError as exc:
            raise HotWatchConfigError(
                f"{field_name} must be an ISO 8601 timestamp"
            ) from exc
    else:
        raise HotWatchConfigError(f"{field_name} must be an ISO 8601 timestamp")
    if parsed.tzinfo is None:
        raise HotWatchConfigError(f"{field_name} must include a timezone")
    return parsed.astimezone(UTC)


def _company_map(companies: list[Company]) -> dict[str, Company]:
    return {company.slug: company for company in companies}


def _resolve_source(
    companies: list[Company],
    company_slug: str,
    source_type: str | None,
) -> tuple[Company, SourceConfig]:
    company = _company_map(companies).get(company_slug)
    if company is None:
        raise HotWatchConfigError(f"unknown company: {company_slug}")
    if source_type is None:
        if len(company.sources) != 1:
            raise HotWatchConfigError(
                f"company '{company_slug}' has multiple sources; specify --source"
            )
        return company, company.sources[0]
    source = next(
        (candidate for candidate in company.sources if candidate.type == source_type),
        None,
    )
    if source is None:
        raise HotWatchConfigError(
            f"company '{company_slug}' does not have source '{source_type}'"
        )
    return company, source


def _watch_from_entry(entry: object, companies: list[Company]) -> HotWatch:
    if not isinstance(entry, dict):
        raise HotWatchConfigError("each hot_watches entry must be a mapping")
    company_slug = entry.get("company_slug")
    source_type = entry.get("source_type")
    if not isinstance(company_slug, str) or not company_slug:
        raise HotWatchConfigError("company_slug must be a non-empty string")
    if not isinstance(source_type, str) or not source_type:
        raise HotWatchConfigError("source_type must be a non-empty string")
    _resolve_source(companies, company_slug, source_type)

    raw_interval = entry.get("interval_minutes")
    if isinstance(raw_interval, bool) or not isinstance(raw_interval, int):
        raise HotWatchConfigError("interval_minutes must be an integer")
    if raw_interval < MANAGED_MIN_INTERVAL_MINUTES:
        raise HotWatchConfigError("interval_minutes must be at least 5")

    starts_at = parse_datetime(entry.get("starts_at"), "starts_at")
    expires_at = parse_datetime(entry.get("expires_at"), "expires_at")
    duration = expires_at - starts_at
    if duration <= timedelta(0):
        raise HotWatchConfigError("expires_at must be after starts_at")
    if duration > MAX_WATCH_DURATION:
        raise HotWatchConfigError("hot watch duration cannot exceed 7 days")

    reason = entry.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise HotWatchConfigError("reason must be a non-empty string")

    return HotWatch(
        company_slug=company_slug,
        source_type=source_type,
        interval_minutes=raw_interval,
        starts_at=starts_at,
        expires_at=expires_at,
        reason=reason.strip(),
    )


def _coalesce(watches: list[HotWatch]) -> tuple[HotWatch, ...]:
    grouped: dict[str, list[HotWatch]] = {}
    for watch in watches:
        grouped.setdefault(watch.key, []).append(watch)
    resolved: list[HotWatch] = []
    for key in sorted(grouped):
        group = grouped[key]
        first = group[0]
        reasons = list(dict.fromkeys(watch.reason for watch in group))
        resolved.append(
            HotWatch(
                company_slug=first.company_slug,
                source_type=first.source_type,
                interval_minutes=min(watch.interval_minutes for watch in group),
                starts_at=min(watch.starts_at for watch in group),
                expires_at=min(watch.expires_at for watch in group),
                reason="; ".join(reasons),
            )
        )
    return tuple(resolved)


def load_overrides(
    path: Path = DEFAULT_OVERRIDES_PATH,
    companies: list[Company] | None = None,
    *,
    now: datetime | None = None,
) -> OverrideConfig:
    resolved_now = (now or datetime.now(UTC)).astimezone(UTC)
    resolved_companies = companies if companies is not None else load_registry()
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        return OverrideConfig()
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise HotWatchConfigError("polling-overrides.yaml must be a mapping")
    entries = raw.get("hot_watches", [])
    if not isinstance(entries, list):
        raise HotWatchConfigError("hot_watches must be a list")
    watches = _coalesce(
        [_watch_from_entry(entry, resolved_companies) for entry in entries]
    )
    active_or_future = tuple(
        watch for watch in watches if watch.expires_at > resolved_now
    )
    expired = tuple(watch for watch in watches if watch.expires_at <= resolved_now)
    return OverrideConfig(watches=active_or_future, expired=expired)


def active_watches(config: OverrideConfig, now: datetime | None = None) -> tuple[HotWatch, ...]:
    resolved_now = (now or datetime.now(UTC)).astimezone(UTC)
    return tuple(
        watch
        for watch in config.watches
        if watch.starts_at <= resolved_now < watch.expires_at
    )


def save_overrides(path: Path, watches: list[HotWatch] | tuple[HotWatch, ...]) -> None:
    entries = [
        {
            "company_slug": watch.company_slug,
            "source_type": watch.source_type,
            "interval_minutes": watch.interval_minutes,
            "starts_at": format_utc(watch.starts_at),
            "expires_at": format_utc(watch.expires_at),
            "reason": watch.reason,
        }
        for watch in sorted(watches, key=lambda item: item.key)
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        yaml.safe_dump({"hot_watches": entries}, sort_keys=False),
        encoding="utf-8",
    )
    temporary.replace(path)


def is_watch_due(
    watch: HotWatch,
    source_health: SourceHealth | None,
    now: datetime | None = None,
) -> bool:
    resolved_now = (now or datetime.now(UTC)).astimezone(UTC)
    if not (watch.starts_at <= resolved_now < watch.expires_at):
        return False
    if source_health is None or source_health.last_polled_at is None:
        return True
    last_polled = parse_datetime(source_health.last_polled_at, "last_polled_at")
    return resolved_now - last_polled >= timedelta(minutes=watch.interval_minutes)


def require_recent_baseline(
    state: RunState,
    source_key: str,
    now: datetime | None = None,
) -> None:
    resolved_now = (now or datetime.now(UTC)).astimezone(UTC)
    health = state.sources.get(source_key)
    if (
        health is None
        or health.last_polled_at is None
        or not health.healthy
        or not health.bootstrapped
    ):
        raise HotWatchConfigError(
            f"a recent successful bootstrapped baseline is required for {source_key}"
        )
    last_polled = parse_datetime(health.last_polled_at, "baseline last_polled_at")
    age = resolved_now - last_polled
    if age < timedelta(0) or age > MAX_BASELINE_AGE:
        raise HotWatchConfigError(
            f"a baseline within the last 24 hours is required for {source_key}"
        )


def enable_watch(
    path: Path,
    companies: list[Company],
    state: RunState,
    *,
    company_slug: str,
    source_type: str | None,
    interval_minutes: int,
    duration: timedelta,
    reason: str,
    now: datetime | None = None,
    dry_run: bool = False,
) -> HotWatch:
    resolved_now = (now or datetime.now(UTC)).astimezone(UTC)
    _, source = _resolve_source(companies, company_slug, source_type)
    if interval_minutes < MANAGED_MIN_INTERVAL_MINUTES:
        raise HotWatchConfigError("managed interval must be at least 5 minutes")
    if duration <= timedelta(0) or duration > MAX_WATCH_DURATION:
        raise HotWatchConfigError("watch duration must be positive and at most 7 days")
    if not reason.strip():
        raise HotWatchConfigError("reason must be a non-empty string")
    key = f"{source.type}:{company_slug}"
    require_recent_baseline(state, key, resolved_now)
    watch = HotWatch(
        company_slug=company_slug,
        source_type=source.type,
        interval_minutes=interval_minutes,
        starts_at=resolved_now,
        expires_at=resolved_now + duration,
        reason=reason.strip(),
    )
    existing = load_overrides(path, companies, now=resolved_now)
    retained = [
        candidate
        for candidate in (*existing.watches, *existing.expired)
        if candidate.key != watch.key
    ]
    if not dry_run:
        save_overrides(path, [*retained, watch])
    return watch


def disable_watch(
    path: Path,
    companies: list[Company],
    *,
    company_slug: str,
    source_type: str | None,
    now: datetime | None = None,
    dry_run: bool = False,
) -> bool:
    _, source = _resolve_source(companies, company_slug, source_type)
    key = f"{source.type}:{company_slug}"
    config = load_overrides(path, companies, now=now)
    current = [*config.watches, *config.expired]
    retained = [watch for watch in current if watch.key != key]
    removed = len(retained) != len(current)
    if removed and not dry_run:
        save_overrides(path, retained)
    return removed


def record_watch_result(
    state: RunState,
    watch: HotWatch,
    *,
    succeeded: bool,
    changes_found: int,
    request_count: int,
    now: datetime | None = None,
) -> HotWatchStats:
    resolved_now = now or datetime.now(UTC)
    previous = state.hot_watch_stats.get(watch.key)
    watch_started_at = format_utc(watch.starts_at)
    if previous is not None and previous.watch_started_at == watch_started_at:
        stats = dataclasses.replace(previous)
    else:
        stats = HotWatchStats(
            watch_started_at=watch_started_at,
            watch_expires_at=format_utc(watch.expires_at),
            requested_interval_minutes=watch.interval_minutes,
            effective_interval_minutes=watch.interval_minutes,
        )
    stats.watch_started_at = format_utc(watch.starts_at)
    stats.watch_expires_at = format_utc(watch.expires_at)
    stats.requested_interval_minutes = watch.interval_minutes
    stats.effective_interval_minutes = watch.interval_minutes
    stats.request_count += max(0, request_count)
    if succeeded:
        stats.successful_polls += 1
        stats.consecutive_failures = 0
        stats.changes_found += max(0, changes_found)
        if changes_found:
            stats.last_change_at = format_utc(resolved_now)
        stats.healthy = True
    else:
        stats.failures += 1
        stats.consecutive_failures += 1
        stats.healthy = stats.consecutive_failures < 3
    state.hot_watch_stats[watch.key] = stats
    return stats


async def poll_once_local(
    company: Company,
    source: SourceConfig,
    *,
    baseline_ids: set[str],
    now: datetime | None = None,
) -> LocalPollResult:
    now_str = format_utc(now or datetime.now(UTC))
    adapter = get_adapter(source.type)
    try:
        async with RateLimitedClient() as client:
            raw_postings = await adapter.fetch(client, company, source)
        postings = [adapter.normalize(raw, company, now_str) for raw in raw_postings]
    except (SourceFetchError, SourceParseError) as exc:
        return LocalPollResult(
            success=False,
            current_ids=None,
            added_ids=frozenset(),
            error=exc.message,
        )
    current_ids = frozenset(posting.id for posting in postings)
    return LocalPollResult(
        success=True,
        current_ids=current_ids,
        added_ids=frozenset(current_ids - baseline_ids),
    )


async def poll_active_watches(
    *,
    overrides_path: Path = DEFAULT_OVERRIDES_PATH,
    registry_path: Path | None = None,
    data_dir: Path = DEFAULT_DATA_DIR,
    now: datetime | None = None,
) -> HotWatchCycleResult:
    from poller.main import run_pipeline

    resolved_now = (now or datetime.now(UTC)).astimezone(UTC)
    companies = load_registry(registry_path)
    config = load_overrides(overrides_path, companies, now=resolved_now)
    active = active_watches(config, resolved_now)
    state_path = data_dir / "state.json"
    state = load_state(state_path)
    due = tuple(
        watch
        for watch in active
        if is_watch_due(watch, state.sources.get(watch.key), resolved_now)
    )
    if not due:
        return HotWatchCycleResult(
            active_keys=frozenset(watch.key for watch in active),
            attempted_keys=frozenset(),
            successful_keys=frozenset(),
            failed_keys=frozenset(),
            unhealthy_keys=frozenset(
                key for key, stats in state.hot_watch_stats.items() if not stats.healthy
            ),
            expired_keys=frozenset(watch.key for watch in config.expired),
        )

    pipeline_result = await run_pipeline(
        dry_run=True,
        registry_path=registry_path,
        data_dir=data_dir,
        skip_simplify=True,
        skip_registry_candidates=True,
        only_source_keys={watch.key for watch in due},
        force_poll=True,
        now=resolved_now,
    )
    updated_state = load_state(state_path)
    feed = load_feed(data_dir / "feed.json")
    new_counts: dict[str, int] = {}
    for posting_id in pipeline_result.new_ids:
        posting = feed.get(posting_id)
        if posting is None:
            continue
        key = f"{posting.source}:{posting.company_slug}"
        new_counts[key] = new_counts.get(key, 0) + 1
    for watch in due:
        record_watch_result(
            updated_state,
            watch,
            succeeded=watch.key in pipeline_result.successful_keys,
            changes_found=new_counts.get(watch.key, 0),
            request_count=pipeline_result.request_counts.get(watch.key, 0),
            now=resolved_now,
        )
    save_state(state_path, updated_state)
    unhealthy = frozenset(
        key for key, stats in updated_state.hot_watch_stats.items() if not stats.healthy
    )
    return HotWatchCycleResult(
        active_keys=frozenset(watch.key for watch in active),
        attempted_keys=pipeline_result.attempted_keys,
        successful_keys=pipeline_result.successful_keys,
        failed_keys=pipeline_result.failed_keys,
        unhealthy_keys=unhealthy,
        expired_keys=frozenset(watch.key for watch in config.expired),
    )
