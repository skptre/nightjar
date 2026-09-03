from __future__ import annotations

import asyncio
import hashlib
import logging
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from poller.dedupe import dedupe_postings
from poller.diff import compute_diff
from poller.exceptions import SourceFetchError, SourceParseError
from poller.filter import (
    filter_feed_mapping,
    filter_student_roles,
    filter_us_locations,
)
from poller.http import RateLimitedClient
from poller.models import Posting, SourceHealth
from poller.registry import (
    classify_tier_distribution,
    is_off_season,
    is_poll_due,
    load_registry,
    prioritize_due_sources,
    update_source_activity,
)
from poller.sources import get_adapter
from poller.store import (
    load_feed,
    load_state,
    save_feed,
    save_meta,
    save_state,
)

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
FEED_PATH = DATA_DIR / "feed.json"
STATE_PATH = DATA_DIR / "state.json"
META_PATH = DATA_DIR / "meta.json"


@dataclass(frozen=True)
class PipelineRunResult:
    attempted_keys: frozenset[str] = field(default_factory=frozenset)
    successful_keys: frozenset[str] = field(default_factory=frozenset)
    failed_keys: frozenset[str] = field(default_factory=frozenset)
    new_ids: frozenset[str] = field(default_factory=frozenset)
    closed_ids: frozenset[str] = field(default_factory=frozenset)
    request_counts: dict[str, int] = field(default_factory=dict)


async def _fetch_simplify(
    companies: list[Any],
    state: Any,
    now_str: str,
    skip_registry_candidates: bool,
    data_dir: Path,
) -> list[Posting]:
    from poller.sources.simplify import SimplifyAdapter, generate_registry_candidates

    adapter = SimplifyAdapter()
    key = "simplify:__meta__"
    prev_health = state.sources.get(key, SourceHealth())

    try:
        async with RateLimitedClient() as client:
            dummy_company = type("Company", (), {
                "slug": "__simplify__", "name": "Simplify",
                "tags": [], "sources": [],
            })()
            dummy_source = type("SourceConfig", (), {
                "type": "simplify", "board_token": "",
            })()
            raw_postings = await adapter.fetch(client, dummy_company, dummy_source)

        postings = [adapter.normalize(raw, dummy_company, now_str) for raw in raw_postings]

        state.sources[key] = SourceHealth(
            last_polled_at=now_str,
            healthy=True,
            bootstrapped=prev_health.bootstrapped,
        )
        logger.info("[simplify] %d postings fetched", len(postings))

        if not skip_registry_candidates:
            known_slugs = {c.slug for c in companies}
            generate_registry_candidates(
                postings, known_slugs, data_dir / "registry_candidates.json",
            )

        return postings

    except (SourceFetchError, SourceParseError) as exc:
        logger.error("[simplify] %s", exc)
        state.sources[key] = SourceHealth(
            last_polled_at=prev_health.last_polled_at,
            healthy=False,
            error=str(exc),
            bootstrapped=prev_health.bootstrapped,
        )
        return []


async def _poll_source(
    client: RateLimitedClient,
    company: Any,
    source: Any,
    now_str: str,
    prev_health: SourceHealth,
) -> tuple[str, list[Posting], SourceHealth, float]:
    key = f"{source.type}:{company.slug}"
    adapter = get_adapter(source.type)
    started = time.monotonic()

    try:
        raw_postings = await adapter.fetch(client, company, source)
        postings = [adapter.normalize(raw, company, now_str) for raw in raw_postings]

        truncated = getattr(adapter, "potentially_truncated", False)

        health = SourceHealth(
            last_polled_at=now_str,
            healthy=True,
            bootstrapped=prev_health.bootstrapped,
            potentially_truncated=truncated,
            last_change_at=prev_health.last_change_at,
            change_frequency=prev_health.change_frequency,
            consecutive_unchanged=prev_health.consecutive_unchanged,
            estimated_poll_cost=prev_health.estimated_poll_cost,
            activity_poll_count=prev_health.activity_poll_count,
        )

        duration = time.monotonic() - started
        logger.info("[%s] %d postings fetched (%.1fs)", key, len(postings), duration)
        return key, postings, health, duration

    except (SourceFetchError, SourceParseError) as exc:
        logger.error("[%s] %s", key, exc)
        duration = time.monotonic() - started
        health = SourceHealth(
            last_polled_at=prev_health.last_polled_at,
            healthy=False,
            error=str(exc),
            bootstrapped=prev_health.bootstrapped,
            potentially_truncated=prev_health.potentially_truncated,
            last_change_at=prev_health.last_change_at,
            change_frequency=prev_health.change_frequency,
            consecutive_unchanged=prev_health.consecutive_unchanged,
            estimated_poll_cost=prev_health.estimated_poll_cost,
            activity_poll_count=prev_health.activity_poll_count,
        )
        return key, [], health, duration


async def run_pipeline(
    dry_run: bool = False,
    *,
    registry_path: Path | None = None,
    data_dir: Path | None = None,
    skip_simplify: bool = False,
    skip_registry_candidates: bool = False,
    only_source_keys: set[str] | None = None,
    force_poll: bool = False,
    now: datetime | None = None,
) -> PipelineRunResult:
    resolved_data = data_dir or DATA_DIR
    feed_path = resolved_data / "feed.json"
    state_path = resolved_data / "state.json"
    meta_path = resolved_data / "meta.json"

    started_monotonic = time.monotonic()
    run_now = (now or datetime.now(UTC)).astimezone(UTC)
    now_str = run_now.strftime("%Y-%m-%dT%H:%M:%SZ")

    logger.info("loading registry")
    companies = load_registry(registry_path)
    logger.info("loaded %d companies", len(companies))

    state = load_state(state_path)
    previous_feed = load_feed(feed_path)
    previous_count = len(previous_feed)
    previous_feed = filter_feed_mapping(previous_feed)
    scope_pruned_count = previous_count - len(previous_feed)
    if scope_pruned_count:
        scoped_ids = set(previous_feed)
        state.active_ids.intersection_update(scoped_ids)
        state.absent_ids = {
            posting_id: absent_at
            for posting_id, absent_at in state.absent_ids.items()
            if posting_id in scoped_ids
        }
    logger.info(
        "loaded state (run %d) and feed (%d postings)",
        state.run_count,
        len(previous_feed),
    )

    due_tasks: list[tuple[Any, Any]] = []
    off_season_skipped: set[str] = set()
    for company in companies:
        for source in company.sources:
            if source.type == "simplify":
                continue
            key = f"{source.type}:{company.slug}"
            if only_source_keys is not None and key not in only_source_keys:
                continue
            health = state.sources.get(key)
            if force_poll or is_poll_due(company, health, run_now):
                due_tasks.append((company, source))
            elif is_off_season(company, run_now):
                off_season_skipped.add(company.slug)

    tier_dist = classify_tier_distribution(state.sources)
    logger.info(
        "adaptive tiers: %d hot, %d active, %d quiet, %d unknown",
        tier_dist["hot"], tier_dist["active"],
        tier_dist["quiet"], tier_dist["unknown"],
    )

    prioritized_tasks, deferred_tasks = prioritize_due_sources(
        due_tasks, state.sources,
    )
    if deferred_tasks:
        deferred_slugs = [t[0].slug for t in deferred_tasks]
        logger.info(
            "cost-aware scheduling deferred %d quiet sources: %s",
            len(deferred_tasks), ", ".join(deferred_slugs[:10]),
        )

    logger.info("%d sources due for polling", len(prioritized_tasks))
    logger.info(
        "seasonal scheduling skipped %d off-season companies this cycle",
        len(off_season_skipped),
    )

    fetch_results: dict[str, list[Posting]] = {}
    updated_sources: dict[str, SourceHealth] = {}
    request_counts: dict[str, int] = {}

    if prioritized_tasks:
        async with RateLimitedClient() as client:
            client.load_cache(state.http_cache)
            coros = [
                _poll_source(
                    client,
                    company,
                    source,
                    now_str,
                    state.sources.get(
                        f"{source.type}:{company.slug}", SourceHealth()
                    ),
                )
                for company, source in prioritized_tasks
            ]
            results = await asyncio.gather(*coros)

        state.http_cache = client.dump_cache()
        request_counts = client.source_request_counts()

        for key, postings, health, duration in results:
            if health.healthy:
                current_ids = sorted(p.id for p in postings)
                raw_hash = hashlib.sha256(
                    ",".join(current_ids).encode()
                ).hexdigest()[:16]
                changed = raw_hash != health.last_raw_id_hash
                health = update_source_activity(
                    health, changed=changed,
                    poll_duration=duration, now=run_now,
                    raw_id_hash=raw_hash,
                )
                fetch_results[key] = postings
            updated_sources[key] = health

    polled_keys = set(fetch_results.keys())
    current_postings: list[Posting] = []

    for postings in fetch_results.values():
        current_postings.extend(postings)

    if not skip_simplify:
        simplify_postings = await _fetch_simplify(
            companies, state, now_str, skip_registry_candidates, resolved_data,
        )
        current_postings.extend(simplify_postings)

    for posting in previous_feed.values():
        key = f"{posting.source}:{posting.company_slug}"
        if key not in polled_keys and posting.closed_at is None:
            current_postings.append(posting)

    current_postings = filter_student_roles(current_postings)
    current_postings = filter_us_locations(current_postings)
    current_postings = dedupe_postings(current_postings)

    for key, health in updated_sources.items():
        state.sources[key] = health

    updated_feed, updated_state, diff = compute_diff(
        current_postings, previous_feed, state, now_str,
    )

    logger.info(
        "diff: +%d new, -%d closed, %d active, %d expired, %d bootstrapped",
        len(diff.new_ids),
        len(diff.closed_ids),
        len(updated_feed),
        len(diff.expired_ids),
        len(diff.bootstrapped_ids),
    )

    output_changed = diff.has_changes or scope_pruned_count > 0

    if output_changed:
        save_feed(feed_path, updated_feed, now_str, companies=companies)
        save_meta(meta_path, feed_path, now_str, len(updated_feed))
        logger.info("feed.json written (%d postings)", len(updated_feed))
    else:
        logger.info("no feed changes, skipping write")

    elapsed = time.monotonic() - started_monotonic
    updated_state.run_duration_seconds = elapsed

    save_state(state_path, updated_state)
    logger.info("state.json written (run %d)", updated_state.run_count)

    active = len(updated_feed)
    new = len(diff.new_ids)
    closed = len(diff.closed_ids)
    commit_msg = f"poll: {active} active, +{new} new, -{closed} closed"
    commit_msg_path = resolved_data / "commit_msg.txt"
    commit_msg_path.write_text(commit_msg, encoding="utf-8")

    if not dry_run and output_changed:
        _git_commit_push(
            len(updated_feed), len(diff.new_ids), len(diff.closed_ids),
        )
    elif dry_run:
        logger.info("dry-run mode, skipping git commit/push")

    logger.info("pipeline complete in %.1fs", elapsed)
    attempted_keys = frozenset(
        f"{source.type}:{company.slug}" for company, source in prioritized_tasks
    )
    successful_keys = frozenset(fetch_results)
    return PipelineRunResult(
        attempted_keys=attempted_keys,
        successful_keys=successful_keys,
        failed_keys=attempted_keys - successful_keys,
        new_ids=diff.new_ids,
        closed_ids=diff.closed_ids,
        request_counts=request_counts,
    )


def _git_commit_push(total: int, new: int, closed: int) -> None:
    msg = f"poll: {total} active, +{new} new, -{closed} closed"
    try:
        subprocess.run(
            ["git", "add", "data/"],
            check=True,
            cwd=ROOT_DIR,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", msg],
            check=True,
            cwd=ROOT_DIR,
            capture_output=True,
        )
        subprocess.run(
            ["git", "push"],
            check=True,
            cwd=ROOT_DIR,
            capture_output=True,
        )
        logger.info("committed and pushed: %s", msg)
    except subprocess.CalledProcessError as exc:
        logger.error("git operation failed: %s", exc)


def main() -> None:
    dry_run = "--dry-run" in sys.argv or "--once" in sys.argv
    skip_simplify = "--skip-simplify" in sys.argv
    skip_registry_candidates = "--skip-registry-candidates" in sys.argv

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if dry_run:
        logger.info("nightjar poller: dry-run mode")
    else:
        logger.info("nightjar poller: live mode")

    asyncio.run(run_pipeline(
        dry_run=dry_run,
        skip_simplify=skip_simplify,
        skip_registry_candidates=skip_registry_candidates,
    ))
