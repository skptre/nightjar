from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

from poller.models import HotWatchStats, Posting, SourceHealth

FEED_VERSION = 1


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
                    "error": v.error,
                    "bootstrapped": v.bootstrapped,
                    "potentially_truncated": v.potentially_truncated,
                    "last_change_at": v.last_change_at,
                    "change_frequency": v.change_frequency,
                    "consecutive_unchanged": v.consecutive_unchanged,
                    "estimated_poll_cost": v.estimated_poll_cost,
                    "activity_poll_count": v.activity_poll_count,
                    "last_raw_id_hash": v.last_raw_id_hash,
                }
                for k, v in sorted(self.sources.items())
            }
        d["active_ids"] = sorted(self.active_ids)
        d["absent_ids"] = dict(sorted(self.absent_ids.items()))
        if self.http_cache:
            d["http_cache"] = dict(sorted(self.http_cache.items()))
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
                error=v.get("error"),
                bootstrapped=v.get("bootstrapped", False),
                potentially_truncated=v.get("potentially_truncated", False),
                last_change_at=v.get("last_change_at"),
                change_frequency=v.get("change_frequency", 0.0),
                consecutive_unchanged=v.get("consecutive_unchanged", 0),
                estimated_poll_cost=v.get("estimated_poll_cost", 0.0),
                activity_poll_count=v.get("activity_poll_count", 0),
                last_raw_id_hash=v.get("last_raw_id_hash"),
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
        "postings": {
            pid: postings[pid].to_dict()
            for pid in sorted(postings)
        },
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
    )


def save_meta(meta_path: Path, feed_path: Path, updated_at: str, count: int) -> None:
    feed_bytes = feed_path.read_bytes()
    sha = hashlib.sha256(feed_bytes).hexdigest()
    meta: dict[str, Any] = {
        "updated_at": updated_at,
        "sha256": sha,
        "count": count,
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
