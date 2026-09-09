"""Stage verified backfill descriptions onto the current feed without replacing poll history."""

from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from poller.registry import load_registry
from poller.store import load_feed, load_state, save_feed, save_feed_sharded, save_meta, save_state


def stage(base: Path, candidates: list[Path], output: Path, registry: Path) -> int:
    if output.resolve() == base.resolve() or output.resolve() in {p.resolve() for p in candidates}:
        raise ValueError("Release output must be separate from its inputs")
    postings = load_feed(base / "feed.json")
    state = load_state(base / "state.json")
    changed: set[str] = set()
    for directory in candidates:
        candidate_state = load_state(directory / "state.json")
        for pid, recovered in load_feed(directory / "feed.json").items():
            current = postings.get(pid)
            if (
                not current
                or current.closed_at
                or recovered.url != current.url
                or recovered.title != current.title
            ):
                continue
            if not recovered.description_text:
                if not current.description_text:
                    postings[pid] = replace(
                        current, description_status=recovered.description_status
                    )
                    if pid in candidate_state.description_attempts:
                        state.description_attempts[pid] = candidate_state.description_attempts[pid]
                continue
            if (
                current.description_status == "available"
                and recovered.description_status != "available"
            ):
                continue
            metadata = dict(current.source_metadata or {})
            for key in ("description_acquisition", "advertised_compensation"):
                if key in (recovered.source_metadata or {}):
                    metadata[key] = recovered.source_metadata[key]  # type: ignore[index]
            postings[pid] = replace(
                current,
                description_text=recovered.description_text,
                description_status=recovered.description_status,
                description_version=recovered.description_version,
                compensation=recovered.compensation or current.compensation,
                source_metadata=metadata or None,
            )
            if pid in candidate_state.description_attempts:
                state.description_attempts[pid] = candidate_state.description_attempts[pid]
            changed.add(pid)
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    companies = load_registry(registry)
    save_feed(output / "feed.json", postings, now, companies=companies)
    shards = save_feed_sharded(output / "feed", postings, now, companies=companies)
    save_meta(output / "meta.json", output / "feed.json", now, len(postings), shard_hashes=shards)
    save_state(output / "state.json", state)
    return len(changed)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=Path("data"))
    parser.add_argument("--candidate", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, default=Path(".tmp/description-ready"))
    parser.add_argument("--registry", type=Path, default=Path("companies.yaml"))
    args = parser.parse_args()
    count = stage(args.base, args.candidate, args.output, args.registry)
    print(f"Staged descriptions for {count} jobs")


if __name__ == "__main__":
    main()
