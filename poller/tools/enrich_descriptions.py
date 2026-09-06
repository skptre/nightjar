"""Inventory or backfill public descriptions into an isolated output directory.

Inventory is offline. --live explicitly enables public-source requests. Input is never
overwritten, and no commit, workflow dispatch, or production publishing is performed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from poller.description_pipeline import collect_descriptions, resolve_detail_posting
from poller.http import RateLimitedClient
from poller.store import RunState, load_feed, load_state, save_feed, save_feed_sharded, save_state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed", type=Path, default=Path("data/feed.json"))
    parser.add_argument("--output", type=Path, default=Path(".tmp/description-backfill"))
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    postings = load_feed(args.feed)
    active = [p for p in postings.values() if p.closed_at is None]
    report = {
        "active": len(active),
        "with_description": sum(bool(p.description_text) for p in active),
        "resolvable_ats": sum(resolve_detail_posting(p) is not None for p in active),
        "by_ats": dict(Counter(p.ats for p in active)),
        "live": args.live,
    }
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
                enriched, count = await collect_descriptions(
                    active,
                    previous,
                    client,
                    state=state.description_attempts,
                    now=now,
                    limit=args.limit,
                )
            combined = {**postings, **{p.id: p for p in enriched}}
            save_feed(output / "feed.json", combined, now)
            save_feed_sharded(output / "feed", combined, now)
            save_state(state_path, state)
            return count, sum(bool(p.description_text) for p in enriched)

        fetched, available = asyncio.run(run())
        report.update({"fetched_this_run": fetched, "with_description_after": available})
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
