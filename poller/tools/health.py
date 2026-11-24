"""Check collection freshness and source health without exposing raw diagnostics."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from poller.models import SourceHealth
from poller.store import RunState, load_state


def build_health_report(
    state: RunState, now: datetime, *, source_keys: set[str] | None = None
) -> dict[str, Any]:
    def age(timestamp: str | None) -> float | None:
        if not timestamp:
            return None
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return round(max(0.0, (now - parsed).total_seconds() / 60), 1)

    active = (
        state.sources
        if source_keys is None
        else {key: state.sources.get(key, SourceHealth()) for key in source_keys}
    )
    sources = {
        key: {
            "healthy": health.healthy
            and not health.potentially_truncated
            and age(health.last_polled_at) is not None
            and (age(health.last_polled_at) or 0) <= 24 * 60,
            "last_verified_at": health.last_polled_at,
            "age_minutes": age(health.last_polled_at),
            "incomplete": health.potentially_truncated,
            "needs_review": bool(health.error and "Suspicious result drop" in health.error),
        }
        for key, health in sorted(active.items())
    }
    return {
        "checked_at": now.isoformat(),
        "last_collection_at": state.last_run_at,
        "collection_age_minutes": age(state.last_run_at),
        "healthy": bool(sources) and all(s["healthy"] for s in sources.values()),
        "sources": sources,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--max-age-minutes", type=float, default=60)
    args = parser.parse_args()
    from poller.registry import load_registry

    keys = {f"{s.type}:{c.slug}" for c in load_registry() for s in c.sources} | {
        "simplify:__meta__"
    }
    report = build_health_report(
        load_state(args.data_dir / "state.json"), datetime.now(UTC), source_keys=keys
    )
    print(json.dumps(report, indent=2))
    age = report["collection_age_minutes"]
    if not report["healthy"] or age is None or age > args.max_age_minutes:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
