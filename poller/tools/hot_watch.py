from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from datetime import UTC, datetime, time, timedelta
from pathlib import Path

from poller.hot_watch import (
    DEFAULT_DATA_DIR,
    DEFAULT_OVERRIDES_PATH,
    LOCAL_MIN_INTERVAL_MINUTES,
    HotWatchConfigError,
    _resolve_source,
    active_watches,
    disable_watch,
    enable_watch,
    format_utc,
    load_overrides,
    poll_active_watches,
    poll_once_local,
)
from poller.registry import load_registry
from poller.store import load_feed, load_state

logger = logging.getLogger(__name__)
DURATION_PATTERN = re.compile(r"^(?P<value>[1-9]\d*)(?P<unit>[mhd])$")


def parse_duration(value: str) -> timedelta:
    match = DURATION_PATTERN.fullmatch(value.strip().lower())
    if match is None:
        raise argparse.ArgumentTypeError("duration must look like 30m, 48h, or 7d")
    amount = int(match.group("value"))
    unit = match.group("unit")
    if unit == "m":
        return timedelta(minutes=amount)
    if unit == "h":
        return timedelta(hours=amount)
    return timedelta(days=amount)


def parse_interval(value: str) -> int:
    duration = parse_duration(value)
    seconds = duration.total_seconds()
    if seconds % 60:
        raise argparse.ArgumentTypeError("interval must resolve to whole minutes")
    return int(seconds // 60)


def _parse_until(value: str, now: datetime) -> datetime:
    text = value.strip()
    if ":" in text and "T" not in text:
        try:
            local_time = time.fromisoformat(text)
        except ValueError as exc:
            raise HotWatchConfigError("--until must be HH:MM or ISO 8601") from exc
        candidate = datetime.combine(now.date(), local_time, tzinfo=now.tzinfo)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate
    from poller.hot_watch import parse_datetime

    return parse_datetime(text, "until")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage bounded Nightjar hot watches")
    parser.add_argument("--registry", type=Path, default=None)
    parser.add_argument("--state", type=Path, default=DEFAULT_DATA_DIR / "state.json")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES_PATH)
    subparsers = parser.add_subparsers(dest="command", required=True)

    enable = subparsers.add_parser("enable", help="arm an expiring managed watch")
    enable.add_argument("company_slug")
    enable.add_argument("--source", dest="source_type")
    enable.add_argument("--interval", type=parse_interval, default=5)
    enable.add_argument("--for", dest="duration", type=parse_duration, required=True)
    enable.add_argument("--reason", required=True)
    enable.add_argument("--dry-run", action="store_true")

    status = subparsers.add_parser("status", help="show active and expired watches")
    status.add_argument("company_slug", nargs="?")

    disable = subparsers.add_parser("disable", help="disarm a managed watch")
    disable.add_argument("company_slug")
    disable.add_argument("--source", dest="source_type")
    disable.add_argument("--dry-run", action="store_true")

    subparsers.add_parser("poll", help="run one authoritative managed watch cycle")

    run = subparsers.add_parser("run", help="run a non-publishing local foreground watch")
    run.add_argument("company_slug")
    run.add_argument("--source", dest="source_type")
    run.add_argument("--interval", type=parse_interval, default=2)
    run.add_argument("--until", required=True)
    run.add_argument("--once", action="store_true", help=argparse.SUPPRESS)
    return parser


def _print_status(args: argparse.Namespace, now: datetime) -> int:
    companies = load_registry(args.registry)
    config = load_overrides(args.overrides, companies, now=now)
    state = load_state(args.state)
    selected = args.company_slug
    watches = [
        watch
        for watch in (*config.watches, *config.expired)
        if selected is None or watch.company_slug == selected
    ]
    if not watches:
        print("No configured hot watches.")
        return 0
    active_keys = {watch.key for watch in active_watches(config, now)}
    for watch in watches:
        status = "active" if watch.key in active_keys else (
            "expired" if watch.expires_at <= now else "scheduled"
        )
        stats = state.hot_watch_stats.get(watch.key)
        health = "unknown" if stats is None else (
            "healthy" if stats.healthy else "unhealthy"
        )
        print(
            f"{watch.key}: {status}, every {watch.interval_minutes}m, "
            f"expires {format_utc(watch.expires_at)}, {health}; {watch.reason}"
        )
    return 0


async def _run_local(args: argparse.Namespace, now: datetime) -> int:
    if args.interval < LOCAL_MIN_INTERVAL_MINUTES:
        raise HotWatchConfigError("local interval must be at least 2 minutes")
    companies = load_registry(args.registry)
    company, source = _resolve_source(companies, args.company_slug, args.source_type)
    until = _parse_until(args.until, now)
    if until <= now:
        raise HotWatchConfigError("--until must be in the future")
    feed = load_feed(args.data_dir / "feed.json")
    source_key = f"{source.type}:{company.slug}"
    baseline_ids = {
        posting.id
        for posting in feed.values()
        if f"{posting.source}:{posting.company_slug}" == source_key
    }
    print(
        f"Watching {source_key} locally every {args.interval}m until "
        f"{format_utc(until)} from {len(baseline_ids)} baseline IDs."
    )
    current = now
    while current < until:
        result = await poll_once_local(
            company, source, baseline_ids=baseline_ids, now=current
        )
        if not result.success:
            print(f"WATCH FAILURE: {result.error}", file=sys.stderr)
        elif result.added_ids:
            print(f"NEW POSTINGS: {', '.join(sorted(result.added_ids))}")
            baseline_ids.update(result.added_ids)
        else:
            print(f"{format_utc(current)}: no additions")
        if args.once:
            break
        await asyncio.sleep(args.interval * 60)
        current = datetime.now(UTC)
    return 0


async def _dispatch(args: argparse.Namespace, now: datetime) -> int:
    if args.command == "poll":
        result = await poll_active_watches(
            overrides_path=args.overrides,
            registry_path=args.registry,
            data_dir=args.data_dir,
            now=now,
        )
        if not result.active_keys:
            print("No active hot watches; exiting without polling.")
        elif not result.attempted_keys:
            print("Active hot watches are not due yet.")
        else:
            print(
                f"Attempted {len(result.attempted_keys)} watched sources: "
                f"{len(result.successful_keys)} succeeded, "
                f"{len(result.failed_keys)} failed."
            )
        if result.expired_keys:
            print(f"Ignored {len(result.expired_keys)} expired watches.")
        if result.unhealthy_keys:
            print(
                "UNHEALTHY WATCHES: " + ", ".join(sorted(result.unhealthy_keys)),
                file=sys.stderr,
            )
            return 2
        return 0
    if args.command == "run":
        return await _run_local(args, now)
    raise AssertionError(f"unexpected async command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    now = datetime.now(UTC)
    try:
        if args.command == "status":
            return _print_status(args, now)
        if args.command == "enable":
            companies = load_registry(args.registry)
            state = load_state(args.state)
            watch = enable_watch(
                args.overrides,
                companies,
                state,
                company_slug=args.company_slug,
                source_type=args.source_type,
                interval_minutes=args.interval,
                duration=args.duration,
                reason=args.reason,
                now=now,
                dry_run=args.dry_run,
            )
            prefix = "Would enable" if args.dry_run else "Enabled"
            estimate = int((watch.expires_at - watch.starts_at).total_seconds() // 60)
            estimate //= watch.interval_minutes
            print(
                f"{prefix} {watch.key} every {watch.interval_minutes}m until "
                f"{format_utc(watch.expires_at)} (~{estimate} poll cycles)."
            )
            return 0
        if args.command == "disable":
            companies = load_registry(args.registry)
            removed = disable_watch(
                args.overrides,
                companies,
                company_slug=args.company_slug,
                source_type=args.source_type,
                now=now,
                dry_run=args.dry_run,
            )
            if not removed:
                print("No matching hot watch was configured.")
                return 1
            print("Would disable hot watch." if args.dry_run else "Disabled hot watch.")
            return 0
        return asyncio.run(_dispatch(args, now))
    except HotWatchConfigError as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
