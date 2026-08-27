from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

from poller.models import Posting, SourceHealth

FEED_VERSION = 1


@dataclass
class RunState:
    last_run_at: str | None = None
    run_count: int = 0
    sources: dict[str, SourceHealth] = field(default_factory=dict)
    active_ids: set[str] = field(default_factory=set)
    absent_ids: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "last_run_at": self.last_run_at,
            "run_count": self.run_count,
            "sources": {
                k: {
                    "last_polled_at": v.last_polled_at,
                    "healthy": v.healthy,
                    "error": v.error,
                    "bootstrapped": v.bootstrapped,
                    "potentially_truncated": v.potentially_truncated,
                }
                for k, v in sorted(self.sources.items())
            },
            "active_ids": sorted(self.active_ids),
            "absent_ids": dict(sorted(self.absent_ids.items())),
        }

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
            )
        return cls(
            last_run_at=d.get("last_run_at"),
            run_count=d.get("run_count", 0),
            sources=sources,
            active_ids=set(d.get("active_ids", [])),
            absent_ids=dict(d.get("absent_ids", {})),
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
