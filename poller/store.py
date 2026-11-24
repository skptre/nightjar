from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

from poller.models import HotWatchStats, Posting, SourceHealth
from poller.redaction import safe_error

FEED_VERSION = 1
SHARDING_THRESHOLD = 1000


@dataclass
class RunState:
    last_run_at: str | None = None
    run_count: int = 0
    run_duration_seconds: float | None = None
    sources: dict[str, SourceHealth] = field(default_factory=dict)
    active_ids: set[str] = field(default_factory=set)
    absent_ids: dict[str, str] = field(default_factory=dict)
    http_cache: dict[str, dict[str, str]] = field(default_factory=dict)
    hot_watch_stats: dict[str, HotWatchStats] = field(default_factory=dict)
    description_attempts: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "last_run_at": self.last_run_at,
            "run_count": self.run_count,
        }
        if self.run_duration_seconds is not None:
            d["run_duration_seconds"] = round(self.run_duration_seconds, 1)
        d["sources"] = {
            k: {
                "last_polled_at": v.last_polled_at,
                "healthy": v.healthy,
                "error": safe_error(v.error) if v.error else None,
                "bootstrapped": v.bootstrapped,
                "potentially_truncated": v.potentially_truncated,
                "last_change_at": v.last_change_at,
                "change_frequency": v.change_frequency,
                "consecutive_unchanged": v.consecutive_unchanged,
                "estimated_poll_cost": v.estimated_poll_cost,
                "activity_poll_count": v.activity_poll_count,
                "last_content_hash": v.last_content_hash,
                "last_complete_count": v.last_complete_count,
            }
            for k, v in sorted(self.sources.items())
        }
        d["active_ids"] = sorted(self.active_ids)
        d["absent_ids"] = dict(sorted(self.absent_ids.items()))
        if self.http_cache:
            d["http_cache"] = dict(sorted(self.http_cache.items()))
        if self.description_attempts:
            d["description_attempts"] = {
                key: {k: safe_error(v) if k == "error" else v for k, v in value.items()}
                for key, value in sorted(self.description_attempts.items())
            }
        if self.hot_watch_stats:
            d["hot_watch_stats"] = {
                key: {
                    "watch_started_at": value.watch_started_at,
                    "watch_expires_at": value.watch_expires_at,
                    "requested_interval_minutes": value.requested_interval_minutes,
                    "effective_interval_minutes": value.effective_interval_minutes,
                    "successful_polls": value.successful_polls,
                    "failures": value.failures,
                    "consecutive_failures": value.consecutive_failures,
                    "changes_found": value.changes_found,
                    "last_change_at": value.last_change_at,
                    "request_count": value.request_count,
                    "healthy": value.healthy,
                }
                for key, value in sorted(self.hot_watch_stats.items())
            }
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RunState:
        sources: dict[str, SourceHealth] = {}
        for k, v in d.get("sources", {}).items():
            sources[k] = SourceHealth(
                last_polled_at=v.get("last_polled_at"),
                healthy=v.get("healthy", True),
                error=safe_error(v["error"]) if v.get("error") else None,
                bootstrapped=v.get("bootstrapped", False),
                potentially_truncated=v.get("potentially_truncated", False),
                last_change_at=v.get("last_change_at"),
                change_frequency=v.get("change_frequency", 0.0),
                consecutive_unchanged=v.get("consecutive_unchanged", 0),
                estimated_poll_cost=v.get("estimated_poll_cost", 0.0),
                activity_poll_count=v.get("activity_poll_count", 0),
                last_content_hash=v.get("last_content_hash") or v.get("last_raw_id_hash"),
                last_complete_count=v.get("last_complete_count"),
            )
        raw_duration = d.get("run_duration_seconds")
        duration = float(raw_duration) if raw_duration is not None else None
        hot_watch_stats = {
            key: HotWatchStats(
                watch_started_at=value["watch_started_at"],
                watch_expires_at=value["watch_expires_at"],
                requested_interval_minutes=value["requested_interval_minutes"],
                effective_interval_minutes=value["effective_interval_minutes"],
                successful_polls=value.get("successful_polls", 0),
                failures=value.get("failures", 0),
                consecutive_failures=value.get("consecutive_failures", 0),
                changes_found=value.get("changes_found", 0),
                last_change_at=value.get("last_change_at"),
                request_count=value.get("request_count", 0),
                healthy=value.get("healthy", True),
            )
            for key, value in d.get("hot_watch_stats", {}).items()
        }
        return cls(
            last_run_at=d.get("last_run_at"),
            run_count=d.get("run_count", 0),
            run_duration_seconds=duration,
            sources=sources,
            active_ids=set(d.get("active_ids", [])),
            absent_ids=dict(d.get("absent_ids", {})),
            http_cache=dict(d.get("http_cache", {})),
            hot_watch_stats=hot_watch_stats,
            description_attempts=dict(d.get("description_attempts", {})),
        )


def load_feed(path: Path) -> dict[str, Posting]:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    data = json.loads(text)
    postings: dict[str, Posting] = {}
    for pid, pdata in data.get("postings", {}).items():
        postings[pid] = Posting.from_dict(pdata)
    return postings


def save_feed(
    path: Path,
    postings: dict[str, Posting],
    updated_at: str,
    companies: list[Any] | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    feed: dict[str, Any] = {
        "updated_at": updated_at,
        "version": FEED_VERSION,
        "count": len(postings),
        "postings": {pid: postings[pid].to_dict() for pid in sorted(postings)},
    }
    if companies is not None:
        companies_meta: dict[str, dict[str, str | None]] = {}
        for c in companies:
            companies_meta[c.slug] = {
                "name": c.name,
                "typical_open": c.typical_open,
            }
        feed["companies"] = dict(sorted(companies_meta.items()))
    path.write_text(
        json.dumps(feed, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def load_state(path: Path) -> RunState:
    if not path.exists():
        return RunState()
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return RunState()
    data = json.loads(text)
    return RunState.from_dict(data)


def save_state(path: Path, state: RunState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(state.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def save_meta(
    meta_path: Path,
    feed_path: Path,
    updated_at: str,
    count: int,
    *,
    shard_hashes: dict[str, ShardMeta] | None = None,
) -> None:
    feed_bytes = feed_path.read_bytes()
    sha = hashlib.sha256(feed_bytes.replace(b"\r\n", b"\n")).hexdigest()
    meta: dict[str, Any] = {
        "updated_at": updated_at,
        "sha256": sha,
        "count": count,
    }
    if shard_hashes is not None:
        meta["sharded"] = True
        meta["shards"] = {
            shard_id: {
                "sha256": sm.sha256,
                "count": sm.count,
                "updated_at": sm.updated_at,
                **({"path": sm.path} if sm.path else {}),
            }
            for shard_id, sm in sorted(shard_hashes.items())
        }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


@dataclass(frozen=True)
class ShardMeta:
    sha256: str
    count: int
    updated_at: str
    path: str | None = None


def _partition_by_source(
    postings: dict[str, Posting],
) -> dict[str, dict[str, Posting]]:
    shards: dict[str, dict[str, Posting]] = {}
    for pid, posting in postings.items():
        source = posting.source
        if source not in shards:
            shards[source] = {}
        shards[source][pid] = posting
    return shards


def save_feed_sharded(
    feed_dir: Path,
    postings: dict[str, Posting],
    updated_at: str,
    companies: list[Any] | None = None,
) -> dict[str, ShardMeta]:
    feed_dir.mkdir(parents=True, exist_ok=True)

    from poller.description_packs import prune_description_packs, write_description_packs

    references = write_description_packs(feed_dir, postings)

    def listing(posting: Posting) -> dict[str, Any]:
        row = posting.to_dict()
        if posting.id in references:
            row.pop("description_text", None)
            row["description_ref"] = {
                **references[posting.id],
                "status": posting.description_status,
            }
            # Legacy consumers cannot verify external text. The updated client
            # restores acquisition status only after validating its document.
            row["description_status"] = "unavailable"
        return row

    partitions = _partition_by_source(postings)
    shard_hashes: dict[str, ShardMeta] = {}

    for shard_id, shard_postings in sorted(partitions.items()):
        shard_data: dict[str, Any] = {
            "shard_id": shard_id,
            "updated_at": updated_at,
            "count": len(shard_postings),
            "postings": {pid: listing(shard_postings[pid]) for pid in sorted(shard_postings)},
        }
        shard_path = feed_dir / f"{shard_id}.json"
        try:
            previous = json.loads(shard_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            previous = None

        # A run-level timestamp is not a listing change. Preserve source bytes
        # when only successful-observation timestamps advanced.
        def content(data: dict[str, Any]) -> dict[str, Any]:
            return {
                pid: {k: v for k, v in row.items() if k != "last_seen_at"}
                for pid, row in data.get("postings", {}).items()
            }

        if previous is not None and content(previous) == content(shard_data):
            shard_data = previous
        shard_bytes = (json.dumps(shard_data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        shard_path.write_bytes(shard_bytes)

        sha = hashlib.sha256(shard_bytes).hexdigest()
        relative = f"snapshots/{sha}.json"
        snapshot = feed_dir / relative
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        if not snapshot.exists():
            snapshot.write_bytes(shard_bytes)
        shard_hashes[shard_id] = ShardMeta(
            sha256=sha,
            count=len(shard_postings),
            updated_at=shard_data["updated_at"],
            path=relative,
        )

    index: dict[str, Any] = {
        "version": 1,
        "updated_at": updated_at,
        "total_count": len(postings),
        "shards": [
            {
                "id": sid,
                "count": sm.count,
                "sha256": sm.sha256,
                "updated_at": sm.updated_at,
            }
            for sid, sm in sorted(shard_hashes.items())
        ],
    }
    if companies is not None:
        companies_meta: dict[str, dict[str, str | None]] = {}
        for c in companies:
            companies_meta[c.slug] = {
                "name": c.name,
                "typical_open": c.typical_open,
            }
        index["companies"] = dict(sorted(companies_meta.items()))

    index_path = feed_dir / "index.json"
    index_path.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    stale = {f.name for f in feed_dir.iterdir() if f.suffix == ".json" and f.name != "index.json"}
    live = {f"{sid}.json" for sid in shard_hashes}
    for name in stale - live:
        (feed_dir / name).unlink()

    prune_description_packs(feed_dir, references)
    _prune_snapshots(feed_dir, {sm.path for sm in shard_hashes.values() if sm.path})
    return shard_hashes


def _prune_snapshots(directory: Path, keep: set[str]) -> None:
    """Immutable listing snapshots get the same retirement grace as documents."""
    history_path = directory / ".snapshot-retention"
    try:
        retired = json.loads(history_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        retired = {}
    now = datetime.now(UTC)
    cutoff = (now - timedelta(hours=72)).isoformat()
    root = (directory / "snapshots").resolve()
    for relative in keep:
        retired.pop(relative, None)
    for path in root.glob("*.json"):
        relative = "snapshots/" + path.name
        if relative in keep or not re.fullmatch(r"[a-f0-9]{64}\.json", path.name):
            continue
        retired.setdefault(relative, now.isoformat())
        if retired[relative] < cutoff:
            if path.is_symlink() or path.resolve().parent != root:
                raise ValueError("unsafe snapshot cleanup path")
            path.unlink()
            retired.pop(relative, None)
    history_path.write_text(json.dumps(retired, sort_keys=True), encoding="utf-8")


def load_feed_sharded(feed_dir: Path) -> dict[str, Posting]:
    from poller.description_packs import read_description_pack

    index_path = feed_dir / "index.json"
    if not index_path.exists():
        return {}
    index_text = index_path.read_text(encoding="utf-8")
    if not index_text.strip():
        return {}
    index_data = json.loads(index_text)

    postings: dict[str, Posting] = {}
    packs: dict[tuple[str, str], dict[str, Any]] = {}
    for shard_info in index_data.get("shards", []):
        shard_path = feed_dir / f"{shard_info['id']}.json"
        if not shard_path.exists():
            continue
        shard_text = shard_path.read_text(encoding="utf-8")
        shard_data = json.loads(shard_text)
        for pid, pdata in shard_data.get("postings", {}).items():
            if "description_ref" in pdata:
                pdata["description_text"] = read_description_pack(
                    feed_dir, pdata["description_ref"], cache=packs
                )
                if "status" in pdata["description_ref"]:
                    pdata["description_status"] = pdata["description_ref"]["status"]
            postings[pid] = Posting.from_dict(pdata)

    return postings
