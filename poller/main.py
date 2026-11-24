from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from poller.dedupe import dedupe_postings
from poller.description_pipeline import (
    attach_source_context,
    collect_descriptions,
    greenhouse_board_map,
)
from poller.diff import compute_diff
from poller.exceptions import SourceFetchError, SourceParseError
from poller.filter import (
    filter_feed_mapping,
    filter_student_roles,
    filter_us_locations,
)
from poller.http import RateLimitedClient
from poller.models import Posting, SourceHealth
from poller.redaction import safe_error
from poller.registry import (
    classify_tier_distribution,
    is_off_season,
    is_poll_due,
    load_registry,
    prioritize_due_sources,
    update_source_activity,
)
from poller.sources import get_adapter
from poller.sources.workday import build_public_url, parse_board_token
from poller.store import (
    SHARDING_THRESHOLD,
    load_feed,
    load_state,
    save_feed,
    save_feed_sharded,
    save_meta,
    save_state,
)

logger = logging.getLogger(__name__)


def _drop_warning(previous_count: int | None, current_count: int) -> str | None:
    if previous_count is not None and previous_count >= 20 and current_count <= previous_count / 2:
        return (
            f"Suspicious result drop: {previous_count} -> {current_count}; "
            "closures blocked until source completeness is verified"
        )
    return None


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
FEED_PATH = DATA_DIR / "feed.json"
STATE_PATH = DATA_DIR / "state.json"
META_PATH = DATA_DIR / "meta.json"


def _repair_legacy_workday_urls(
    postings: dict[str, Posting],
    companies: list[Any],
) -> tuple[dict[str, Posting], int]:
    sites: dict[str, tuple[str, str]] = {}
    for company in companies:
        for source in company.sources:
            if source.type != "workday":
                continue
            host, _tenant, site = parse_board_token(source.board_token)
            sites[company.slug] = (host, site)

    repaired = dict(postings)
    changed = 0
    for posting_id, posting in postings.items():
        target = sites.get(posting.company_slug)
        if posting.source != "workday" or target is None:
            continue
        host, site = target
        marker = f"/{site}/"
        if marker in posting.url:
            continue
        path_start = posting.url.find("/job/")
        if path_start < 0:
            continue
        new_url = build_public_url(host, site, posting.url[path_start:])
        repaired[posting_id] = replace(posting, url=new_url)
        changed += 1
    return repaired, changed


def _has_material_feed_updates(
    previous: dict[str, Posting],
    current: dict[str, Posting],
) -> bool:
    for posting_id in set(previous) & set(current):
        before = previous[posting_id].to_dict()
        after = current[posting_id].to_dict()
        before.pop("last_seen_at", None)
        after.pop("last_seen_at", None)
        if before != after:
            return True
    return False


def _meta_uses_shards(path: Path) -> bool:
    try:
        return bool(json.loads(path.read_text(encoding="utf-8")).get("sharded"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False


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
    approve_drop: bool = False,
) -> list[Posting]:
    from poller.sources.simplify import SimplifyAdapter, generate_registry_candidates

    adapter = SimplifyAdapter()
    key = "simplify:__meta__"
    prev_health = state.sources.get(key, SourceHealth())

    try:
        async with RateLimitedClient() as client:
            dummy_company = type(
                "Company",
                (),
                {
                    "slug": "__simplify__",
                    "name": "Simplify",
                    "tags": [],
                    "sources": [],
                },
            )()
            dummy_source = type(
                "SourceConfig",
                (),
                {
                    "type": "simplify",
                    "board_token": "",
                },
            )()
            raw_postings = await adapter.fetch(client, dummy_company, dummy_source)

        postings = [adapter.normalize(raw, dummy_company, now_str) for raw in raw_postings]

        truncated = getattr(adapter, "potentially_truncated", False)
        warning = (
            None if approve_drop else _drop_warning(prev_health.last_complete_count, len(postings))
        )
        state.sources[key] = replace(
            prev_health,
            last_polled_at=now_str,
            healthy=not (truncated or warning),
            potentially_truncated=truncated or warning is not None,
            error=warning
            or ("Incomplete listing response; closures blocked" if truncated else None),
            last_complete_count=(
                prev_health.last_complete_count if truncated or warning else len(postings)
            ),
        )
        logger.info("[simplify] %d postings fetched", len(postings))

        if not skip_registry_candidates:
            known_slugs = {c.slug for c in companies}
            generate_registry_candidates(
                postings,
                known_slugs,
                data_dir / "registry_candidates.json",
                known_source_keys={(s.type, s.board_token) for c in companies for s in c.sources},
            )

        return postings

    except Exception as exc:
        logger.error("[simplify] %s", safe_error(exc))
        state.sources[key] = replace(
            prev_health,
            last_polled_at=prev_health.last_polled_at,
            healthy=False,
            error=safe_error(exc),
            potentially_truncated=(
                not isinstance(exc, SourceFetchError) or prev_health.potentially_truncated
            ),
        )
        return []


async def _poll_source(
    client: RateLimitedClient,
    company: Any,
    source: Any,
    now_str: str,
    prev_health: SourceHealth,
    approve_drop: bool = False,
) -> tuple[str, list[Posting], SourceHealth, float]:
    key = f"{source.type}:{company.slug}"
    adapter = get_adapter(source.type)
    started = time.monotonic()

    try:
        raw_postings = await adapter.fetch(client, company, source)
        postings = [
            attach_source_context(adapter.normalize(raw, company, now_str), raw, source)
            for raw in raw_postings
        ]
        if any(
            not p.id or not p.source_job_id or not p.title.strip() or not p.url for p in postings
        ) or len({p.id for p in postings}) != len(postings):
            raise SourceParseError(
                source.type,
                company.slug,
                "invalid or duplicate posting identity",
            )

        truncated = getattr(adapter, "potentially_truncated", False)
        warning = (
            None
            if approve_drop
            else _drop_warning(prev_health.last_complete_count, len(raw_postings))
        )

        health = replace(
            prev_health,
            last_polled_at=now_str,
            healthy=not (truncated or warning),
            bootstrapped=prev_health.bootstrapped,
            potentially_truncated=truncated or warning is not None,
            error=warning
            or ("Incomplete listing response; closures blocked" if truncated else None),
            last_complete_count=(
                prev_health.last_complete_count if truncated or warning else len(raw_postings)
            ),
            last_change_at=prev_health.last_change_at,
            change_frequency=prev_health.change_frequency,
            consecutive_unchanged=prev_health.consecutive_unchanged,
            estimated_poll_cost=prev_health.estimated_poll_cost,
            activity_poll_count=prev_health.activity_poll_count,
        )

        duration = time.monotonic() - started
        logger.info("[%s] %d postings fetched (%.1fs)", key, len(postings), duration)
        return key, postings, health, duration

    except Exception as exc:
        logger.error("[%s] %s", key, safe_error(exc))
        duration = time.monotonic() - started
        health = replace(
            prev_health,
            last_polled_at=prev_health.last_polled_at,
            healthy=False,
            error=safe_error(exc),
            bootstrapped=prev_health.bootstrapped,
            potentially_truncated=(
                not isinstance(exc, SourceFetchError) or prev_health.potentially_truncated
            ),
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
    description_enrichment: bool | None = None,
    now: datetime | None = None,
    approved_drop_keys: set[str] | None = None,
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

    valid_source_keys = {
        f"{source.type}:{company.slug}" for company in companies for source in company.sources
    }
    valid_source_keys.add("simplify:__meta__")
    approved = approved_drop_keys or set()
    if approved - valid_source_keys:
        raise ValueError("Drop approval names an unknown source")
    stale_keys = [k for k in state.sources if k not in valid_source_keys]
    if stale_keys:
        for k in stale_keys:
            del state.sources[k]
        logger.info(
            "pruned %d stale source(s) from state: %s",
            len(stale_keys),
            ", ".join(sorted(stale_keys)[:10]),
        )

    previous_feed = load_feed(feed_path)
    previous_feed, repaired_url_count = _repair_legacy_workday_urls(previous_feed, companies)
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
        tier_dist["hot"],
        tier_dist["active"],
        tier_dist["quiet"],
        tier_dist["unknown"],
    )

    if force_poll:
        prioritized_tasks = due_tasks
        deferred_tasks: list[tuple[Any, Any]] = []
    else:
        force_keys = set(state.hot_watch_stats.keys()) if state.hot_watch_stats else None
        prioritized_tasks, deferred_tasks = prioritize_due_sources(
            due_tasks,
            state.sources,
            force_include_keys=force_keys,
            now=run_now,
        )
    if deferred_tasks:
        deferred_slugs = [t[0].slug for t in deferred_tasks]
        logger.info(
            "cost-aware scheduling deferred %d quiet sources: %s",
            len(deferred_tasks),
            ", ".join(deferred_slugs[:10]),
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
                    state.sources.get(f"{source.type}:{company.slug}", SourceHealth()),
                    **(
                        {"approve_drop": True}
                        if f"{source.type}:{company.slug}" in approved
                        else {}
                    ),
                )
                for company, source in prioritized_tasks
            ]
            results = await asyncio.gather(*coros)

        state.http_cache = client.dump_cache()
        request_counts = client.source_request_counts()

        for key, postings, health, duration in results:
            if health.healthy:
                content_parts = sorted(f"{p.id}|{p.title}|{p.url}|{p.location}" for p in postings)
                content_hash = hashlib.sha256("\n".join(content_parts).encode()).hexdigest()[:16]
                changed = content_hash != health.last_content_hash
                health = update_source_activity(
                    health,
                    changed=changed,
                    poll_duration=duration,
                    now=run_now,
                    content_hash=content_hash,
                )
                fetch_results[key] = postings
            elif health.potentially_truncated and postings:
                # Valid additions from a partial response are still useful;
                # missing jobs remain protected by the separate closure gate.
                fetch_results[key] = postings
            updated_sources[key] = health

    complete_keys = {
        key
        for key, health in updated_sources.items()
        if health.healthy and not health.potentially_truncated
    }
    current_postings: list[Posting] = []

    for postings in fetch_results.values():
        current_postings.extend(postings)

    if not skip_simplify:
        simplify_postings = await _fetch_simplify(
            companies,
            state,
            now_str,
            skip_registry_candidates,
            resolved_data,
            **({"approve_drop": True} if "simplify:__meta__" in approved else {}),
        )
        current_postings.extend(simplify_postings)
        simplify_health = state.sources.get("simplify:__meta__")
        if (
            simplify_health
            and simplify_health.healthy
            and not simplify_health.potentially_truncated
        ):
            complete_keys.add("simplify:__meta__")

    # Also protect legacy state (which has no raw-count baseline) and detect
    # filtering/schema regressions that leave raw counts apparently unchanged.
    previous_counts: dict[str, int] = {}
    current_counts: dict[str, int] = {}
    for posting in previous_feed.values():
        if posting.closed_at is None:
            key = (
                "simplify:__meta__"
                if posting.source == "simplify"
                else f"{posting.source}:{posting.company_slug}"
            )
            previous_counts[key] = previous_counts.get(key, 0) + 1
    scoped_current = filter_us_locations(filter_student_roles(current_postings))
    for posting in scoped_current:
        key = (
            "simplify:__meta__"
            if posting.source == "simplify"
            else f"{posting.source}:{posting.company_slug}"
        )
        current_counts[key] = current_counts.get(key, 0) + 1
    for key in list(complete_keys):
        warning = _drop_warning(previous_counts.get(key), current_counts.get(key, 0))
        if warning and key not in approved:
            health = state.sources[key] if key == "simplify:__meta__" else updated_sources[key]
            health.potentially_truncated = True
            health.healthy = False
            health.error = warning
            complete_keys.remove(key)
            logger.warning("[%s] %s", key, warning)
    reported_sources = dict(updated_sources)
    if not skip_simplify and "simplify:__meta__" in state.sources:
        reported_sources["simplify:__meta__"] = state.sources["simplify:__meta__"]
    for key, health in reported_sources.items():
        if health.potentially_truncated:
            logger.warning("[%s] %s", key, health.error)
            if os.environ.get("GITHUB_ACTIONS") == "true":
                message = f"{key}: {health.error or 'Incomplete source; closures blocked'}"
                message = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
                print(f"::warning title=Job listing completeness::{message}")

    fresh_ids = {p.id for p in current_postings}
    fresh_description_ids = {
        p.id for p in current_postings if p.description_text and p.description_status == "available"
    }
    # Only a complete, verified replacement board can retire its explicitly
    # declared predecessor. Outages never authorize a migration closure.
    for company in companies:
        for source in company.sources:
            if f"{source.type}:{company.slug}" in complete_keys:
                complete_keys.update(source.replaces)

    for posting in previous_feed.values():
        key = (
            "simplify:__meta__"
            if posting.source == "simplify"
            else f"{posting.source}:{posting.company_slug}"
        )
        if key not in complete_keys and posting.closed_at is None:
            current_postings.append(posting)

    current_postings = filter_student_roles(current_postings)
    current_postings = filter_us_locations(current_postings)
    current_postings = dedupe_postings(current_postings)
    observed_ids = {
        p.id
        for p in current_postings
        if p.id in fresh_ids or any(pid in fresh_ids for pid in p.merged_from)
    }

    # Browser security policies make client-side ATS detail requests unreliable.
    # Runs against the production data directory publish a bounded rotating batch;
    # fixture/custom-data runs remain offline unless explicitly enabled.
    should_enrich_descriptions = (
        data_dir is None if description_enrichment is None else description_enrichment
    )
    if should_enrich_descriptions:
        async with RateLimitedClient() as description_client:
            description_client.load_cache(state.http_cache)
            current_postings, _ = await collect_descriptions(
                current_postings,
                previous_feed,
                description_client,
                state=state.description_attempts,
                now=now_str,
                greenhouse_boards=greenhouse_board_map(companies),
                fresh_description_ids=fresh_description_ids,
            )
            state.http_cache.update(description_client.dump_cache())

    for key, health in updated_sources.items():
        state.sources[key] = health

    updated_feed, updated_state, diff = compute_diff(
        current_postings,
        previous_feed,
        state,
        now_str,
        complete_sources=complete_keys,
        observed_ids=observed_ids,
    )

    logger.info(
        "diff: +%d new, -%d closed, %d active, %d expired, %d bootstrapped",
        len(diff.new_ids),
        len(diff.closed_ids),
        len(updated_feed),
        len(diff.expired_ids),
        len(diff.bootstrapped_ids),
    )

    should_shard = len(updated_feed) >= SHARDING_THRESHOLD
    sharding_state_changed = should_shard != _meta_uses_shards(meta_path)
    output_changed = (
        diff.has_changes
        or scope_pruned_count > 0
        or repaired_url_count > 0
        or _has_material_feed_updates(previous_feed, updated_feed)
        or sharding_state_changed
    )

    if output_changed:
        save_feed(feed_path, updated_feed, now_str, companies=companies)
        shard_hashes = None
        if should_shard:
            feed_shard_dir = resolved_data / "feed"
            shard_hashes = save_feed_sharded(
                feed_shard_dir,
                updated_feed,
                now_str,
                companies=companies,
            )
            logger.info(
                "feed sharded into %d shards (%d postings)",
                len(shard_hashes),
                len(updated_feed),
            )
        save_meta(
            meta_path,
            feed_path,
            now_str,
            len(updated_feed),
            shard_hashes=shard_hashes,
        )
        logger.info("feed.json written (%d postings)", len(updated_feed))
    else:
        logger.info("no feed changes, skipping write")

    elapsed = time.monotonic() - started_monotonic
    updated_state.run_duration_seconds = elapsed

    save_state(state_path, updated_state)
    from poller.tools.health import build_health_report

    report = build_health_report(
        updated_state,
        run_now,
        source_keys={f"{s.type}:{c.slug}" for c in companies for s in c.sources}
        | ({"simplify:__meta__"} if not skip_simplify else set()),
    )
    (resolved_data / "health.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    logger.info("state.json written (run %d)", updated_state.run_count)

    active = len(updated_feed)
    new = len(diff.new_ids)
    closed = len(diff.closed_ids)
    commit_msg = f"poll: {active} active, +{new} new, -{closed} closed"
    commit_msg_path = resolved_data / "commit_msg.txt"
    commit_msg_path.write_text(commit_msg, encoding="utf-8")

    if not dry_run and output_changed:
        _git_commit_push(
            len(updated_feed),
            len(diff.new_ids),
            len(diff.closed_ids),
        )
    elif dry_run:
        logger.info("dry-run mode, skipping git commit/push")

    logger.info("pipeline complete in %.1fs", elapsed)
    attempted_keys = frozenset(
        f"{source.type}:{company.slug}" for company, source in prioritized_tasks
    ) | (frozenset({"simplify:__meta__"}) if not skip_simplify else frozenset())
    successful_keys = frozenset(
        key
        for key in fetch_results
        if updated_sources[key].healthy and not updated_sources[key].potentially_truncated
    )
    if not skip_simplify and "simplify:__meta__" in complete_keys:
        successful_keys |= frozenset({"simplify:__meta__"})
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
    parser = argparse.ArgumentParser(description="Collect and validate public student job listings")
    parser.add_argument("--once", action="store_true", help="Write local data without committing")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-simplify", action="store_true")
    parser.add_argument("--skip-registry-candidates", action="store_true")
    parser.add_argument("--skip-description-enrichment", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--registry", type=Path)
    parser.add_argument(
        "--approve-drop",
        action="append",
        default=[],
        metavar="PROVIDER:COMPANY",
        help="Approve a reviewed count drop for this run; never bypasses adapter validation",
    )
    parser.add_argument("--fail-on-degraded", action="store_true")
    args = parser.parse_args()
    dry_run = args.dry_run or args.once or args.data_dir is not None

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

    result = asyncio.run(
        run_pipeline(
            dry_run=dry_run,
            skip_simplify=args.skip_simplify,
            skip_registry_candidates=args.skip_registry_candidates,
            description_enrichment=not args.skip_description_enrichment,
            registry_path=args.registry,
            data_dir=args.data_dir,
            force_poll=args.force,
            approved_drop_keys=set(args.approve_drop),
        )
    )
    if args.fail_on_degraded:
        report_path = (args.data_dir or DATA_DIR) / "health.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        if result.failed_keys or not report["healthy"]:
            sys.exit(2)
