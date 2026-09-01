"""Coverage benchmark tool — measure and record baseline metrics.

Run: uv run python -m poller.tools.benchmark
Output: data/benchmark.json (append-only timestamped snapshots)
"""
from __future__ import annotations

import json
import logging
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from poller.models import Posting
from poller.registry import load_registry
from poller.store import load_feed, load_state

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT_DIR / "data"
FEED_PATH = DATA_DIR / "feed.json"
STATE_PATH = DATA_DIR / "state.json"
BENCHMARK_PATH = DATA_DIR / "benchmark.json"


def _count_structured_fields(posting: Posting) -> int:
    count = 0
    if posting.employment_type is not None:
        count += 1
    if posting.department is not None:
        count += 1
    if posting.workplace_type is not None:
        count += 1
    if posting.valid_through is not None:
        count += 1
    if posting.compensation is not None:
        count += 1
    return count


def compute_metrics(
    registry_path: Path | None = None,
) -> dict[str, Any]:
    companies = load_registry(registry_path)
    feed = load_feed(FEED_PATH)
    state = load_state(STATE_PATH)

    total_companies = len(companies)

    ats_counts: Counter[str] = Counter()
    tag_counts: Counter[str] = Counter()
    for company in companies:
        for src in company.sources:
            ats_counts[src.type] += 1
        for tag in company.tags:
            tag_counts[tag] += 1

    postings = list(feed.values())
    total_postings = len(postings)

    source_counts: Counter[str] = Counter()
    location_counts: Counter[str] = Counter()
    postings_with_structured = 0
    structured_field_total = 0

    for p in postings:
        source_counts[p.source] += 1
        for loc in p.locations:
            location_counts[loc] += 1
        fields = _count_structured_fields(p)
        if fields >= 2:
            postings_with_structured += 1
        structured_field_total += fields

    healthy_sources = 0
    unhealthy_sources = 0
    for _key, health in state.sources.items():
        if health.healthy:
            healthy_sources += 1
        else:
            unhealthy_sources += 1

    total_sources = healthy_sources + unhealthy_sources
    failure_rate = (
        unhealthy_sources / total_sources * 100 if total_sources else 0
    )

    feed_size_bytes = FEED_PATH.stat().st_size if FEED_PATH.exists() else 0

    return {
        "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "registry": {
            "total_companies": total_companies,
            "companies_by_ats": dict(ats_counts.most_common()),
            "top_tags": dict(tag_counts.most_common(20)),
        },
        "feed": {
            "total_postings": total_postings,
            "postings_by_source": dict(source_counts.most_common()),
            "feed_size_bytes": feed_size_bytes,
            "feed_size_mb": round(feed_size_bytes / (1024 * 1024), 2),
        },
        "data_richness": {
            "postings_with_2plus_structured_fields": postings_with_structured,
            "structured_field_coverage_pct": round(
                postings_with_structured / total_postings * 100, 1
            ) if total_postings else 0,
            "avg_structured_fields_per_posting": round(
                structured_field_total / total_postings, 2
            ) if total_postings else 0,
        },
        "reliability": {
            "healthy_sources": healthy_sources,
            "unhealthy_sources": unhealthy_sources,
            "source_failure_rate_pct": round(failure_rate, 1),
        },
        "pipeline": {
            "run_count": state.run_count,
            "last_run_at": state.last_run_at,
            "last_run_duration_seconds": state.run_duration_seconds,
        },
    }


def run_benchmark(registry_path: Path | None = None) -> None:
    metrics = compute_metrics(registry_path)

    snapshots: list[dict[str, Any]] = []
    if BENCHMARK_PATH.exists():
        text = BENCHMARK_PATH.read_text(encoding="utf-8").strip()
        if text:
            snapshots = json.loads(text)

    snapshots.append(metrics)

    BENCHMARK_PATH.parent.mkdir(parents=True, exist_ok=True)
    BENCHMARK_PATH.write_text(
        json.dumps(snapshots, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    logger.info("benchmark snapshot written to %s", BENCHMARK_PATH)
    logger.info(
        "registry: %d companies | feed: %d postings (%.1f MB) | "
        "failure rate: %.1f%%",
        metrics["registry"]["total_companies"],
        metrics["feed"]["total_postings"],
        metrics["feed"]["feed_size_mb"],
        metrics["reliability"]["source_failure_rate_pct"],
    )


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    registry_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    run_benchmark(registry_path)
