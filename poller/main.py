from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from poller.dedupe import dedupe_postings
from poller.diff import compute_diff
from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import RateLimitedClient
from poller.models import Posting, SourceHealth
from poller.registry import is_poll_due, load_registry
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
) -> tuple[str, list[Posting], SourceHealth]:
    key = f"{source.type}:{company.slug}"
    adapter = get_adapter(source.type)

    try:
        raw_postings = await adapter.fetch(client, company, source)
        postings = [adapter.normalize(raw, company, now_str) for raw in raw_postings]

        truncated = getattr(adapter, "potentially_truncated", False)

        health = SourceHealth(
            last_polled_at=now_str,
            healthy=True,
            bootstrapped=prev_health.bootstrapped,
            potentially_truncated=truncated,
        )

        logger.info("[%s] %d postings fetched", key, len(postings))
        return key, postings, health

    except (SourceFetchError, SourceParseError) as exc:
        logger.error("[%s] %s", key, exc)
        health = SourceHealth(
            last_polled_at=prev_health.last_polled_at,
            healthy=False,
            error=str(exc),
            bootstrapped=prev_health.bootstrapped,
            potentially_truncated=prev_health.potentially_truncated,
        )
        return key, [], health


async def run_pipeline(
    dry_run: bool = False,
    *,
    registry_path: Path | None = None,
    data_dir: Path | None = None,
    skip_simplify: bool = False,
    skip_registry_candidates: bool = False,
) -> None:
    resolved_data = data_dir or DATA_DIR
    feed_path = resolved_data / "feed.json"
    state_path = resolved_data / "state.json"
    meta_path = resolved_data / "meta.json"

    now = datetime.now(UTC)
    now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    logger.info("loading registry")
    companies = load_registry(registry_path)
    logger.info("loaded %d companies", len(companies))

    state = load_state(state_path)
    previous_feed = load_feed(feed_path)
    logger.info(
        "loaded state (run %d) and feed (%d postings)",
        state.run_count,
        len(previous_feed),
    )

    due_tasks: list[tuple[Any, Any]] = []
    for company in companies:
        for source in company.sources:
            if source.type == "simplify":
                continue
            key = f"{source.type}:{company.slug}"
            health = state.sources.get(key)
            if is_poll_due(company, health, now):
                due_tasks.append((company, source))

    logger.info("%d sources due for polling", len(due_tasks))

    fetch_results: dict[str, list[Posting]] = {}
    updated_sources: dict[str, SourceHealth] = {}

    if due_tasks:
        async with RateLimitedClient() as client:
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
                for company, source in due_tasks
            ]
            results = await asyncio.gather(*coros)

        for key, postings, health in results:
            updated_sources[key] = health
            if health.healthy:
                fetch_results[key] = postings

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

    if diff.has_changes:
        save_feed(feed_path, updated_feed, now_str)
        save_meta(meta_path, feed_path, now_str, len(updated_feed))
        logger.info("feed.json written (%d postings)", len(updated_feed))
    else:
        logger.info("no feed changes, skipping write")

    save_state(state_path, updated_state)
    logger.info("state.json written (run %d)", updated_state.run_count)

    if not dry_run and diff.has_changes:
        _git_commit_push(
            len(updated_feed), len(diff.new_ids), len(diff.closed_ids),
        )
    elif dry_run:
        logger.info("dry-run mode, skipping git commit/push")

    elapsed = (datetime.now(UTC) - now).total_seconds()
    logger.info("pipeline complete in %.1fs", elapsed)


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

    if dry_run:
        logger.info("nightjar poller: dry-run mode")
    else:
        logger.info("nightjar poller: live mode")

    asyncio.run(run_pipeline(
        dry_run=dry_run,
        skip_simplify=skip_simplify,
        skip_registry_candidates=skip_registry_candidates,
    ))
