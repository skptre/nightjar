"""Inventory or backfill public descriptions into an isolated output directory.

Inventory is offline. --live explicitly enables public-source requests. Input is never
overwritten, and no commit, workflow dispatch, or production publishing is performed.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from poller.description_pipeline import (
    collect_descriptions,
    greenhouse_board_map,
    resolve_detail_posting,
)
from poller.http import RateLimitedClient
from poller.registry import load_registry
from poller.store import RunState, load_feed, load_state, save_feed, save_feed_sharded, save_state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed", type=Path, default=Path("data/feed.json"))
    parser.add_argument("--output", type=Path, default=Path(".tmp/description-backfill"))
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--registry", type=Path, default=Path("companies.yaml"))
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    postings = load_feed(args.feed)
    boards = greenhouse_board_map(load_registry(args.registry))
    active = [p for p in postings.values() if p.closed_at is None]
    report = {
        "active": len(active),
        "input_sha256": hashlib.sha256(args.feed.read_bytes()).hexdigest(),
        "with_description": sum(bool(p.description_text) for p in active),
        "resolvable_ats": sum(resolve_detail_posting(p, boards) is not None for p in active),
        "by_ats": dict(Counter(p.ats for p in active)),
        "live": args.live,
    }
    if args.limit < 0:
        parser.error("limit must be nonnegative")
    if args.live:
        output = args.output.resolve()
        if (output / "feed.json").resolve() == args.feed.resolve():
            parser.error("output must be separate from the input feed")
        output.mkdir(parents=True, exist_ok=True)
        state_path = output / "state.json"
        state = load_state(state_path) if state_path.exists() else RunState()
        previous = load_feed(output / "feed.json")
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")

        async def run() -> tuple[int, int]:
            async with RateLimitedClient() as client:
                client.load_cache(state.http_cache)
                enriched, count = await collect_descriptions(
                    active,
                    previous,
                    client,
                    state=state.description_attempts,
                    now=now,
                    limit=args.limit,
                    greenhouse_boards=boards,
                )
                state.http_cache.update(client.dump_cache())
            combined = {**postings, **{p.id: p for p in enriched}}
            save_feed(output / "feed.json", combined, now)
            save_feed_sharded(output / "feed", combined, now)
            save_state(state_path, state)
            by_provider: dict[str, Counter[str]] = {}
            for posting in enriched:
                target = resolve_detail_posting(posting, boards)
                provider = target.ats if target else posting.ats
                counts = by_provider.setdefault(provider, Counter())
                counts[posting.description_status or "pending"] += 1
            report["acquisition_by_provider"] = {
                provider: dict(counts) for provider, counts in sorted(by_provider.items())
            }
            report["attempted_this_run"] = sum(
                entry.get("last_attempt_at") == now
                for entry in state.description_attempts.values()
            )
            report["failure_reasons"] = dict(Counter(
                entry.get("error", "unknown") for entry in state.description_attempts.values()
                if entry.get("status") == "failed"
            ))
            report["feed_bytes"] = (output / "feed.json").stat().st_size
            report["shard_bytes"] = {
                path.name: path.stat().st_size for path in sorted((output / "feed").glob("*.json"))
            }
            return count, sum(bool(p.description_text) for p in enriched)

        fetched, available = asyncio.run(run())
        report.update({"fetched_this_run": fetched, "with_description_after": available})
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
