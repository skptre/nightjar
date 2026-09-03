from __future__ import annotations

import dataclasses
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from poller.models import Company, SourceConfig, SourceHealth

logger = logging.getLogger(__name__)

VALID_SOURCE_TYPES = {
    "greenhouse", "lever", "ashby", "workday", "simplify", "smartrecruiters",
    "google_careers", "microsoft_careers",
    "recruitee", "bamboohr", "workable", "breezy",
    "jazzhr", "teamtailor", "pinpoint", "comeet",
    "generic",
}
VALID_SEASONAL_PATTERNS = {"fall", "spring", "year_round"}
DEFAULT_INTERVAL = timedelta(hours=6)
HIGH_PRIORITY_INTERVAL = timedelta(minutes=30)
OFF_SEASON_INTERVAL = timedelta(hours=6)
RAMP_WINDOW_DAYS = 14
FALL_MONTHS = frozenset({7, 8, 9, 10, 11})
SPRING_MONTHS = frozenset({12, 1, 2, 3, 4})

HOT_INTERVAL = timedelta(minutes=15)
ACTIVE_INTERVAL = timedelta(hours=2)
QUIET_INTERVAL = timedelta(hours=6)
MIN_ADAPTIVE_POLLS = 48
HOT_THRESHOLD = 2
ACTIVE_THRESHOLD = 10
ACTIVITY_EMA_ALPHA = 0.2


def load_registry(path: Path | None = None) -> list[Company]:
    if path is None:
        path = Path(__file__).resolve().parent.parent / "companies.yaml"

    raw: list[dict[str, Any]] = yaml.safe_load(path.read_text(encoding="utf-8"))

    if not isinstance(raw, list):
        raise ValueError("companies.yaml must be a YAML list")

    companies: list[Company] = []
    seen_slugs: set[str] = set()

    for entry in raw:
        _validate_entry(entry, seen_slugs)

        sources = [
            SourceConfig(
                type=s["type"],
                board_token=s["board_token"],
                eu=s.get("eu", False),
            )
            for s in entry["sources"]
        ]

        company = Company(
            slug=entry["slug"],
            name=entry["name"],
            tags=entry.get("tags", []),
            sources=sources,
            typical_open=entry.get("typical_open"),
            high_priority=entry.get("high_priority", False),
            seasonal_pattern=entry.get("seasonal_pattern"),
        )

        if not company.tags:
            logger.warning("Company '%s' has no tags", company.slug)

        companies.append(company)
        seen_slugs.add(company.slug)

    return companies


def _validate_entry(entry: dict[str, Any], seen_slugs: set[str]) -> None:
    if "slug" not in entry or not entry["slug"]:
        raise ValueError(f"Company entry missing 'slug': {entry}")

    slug = entry["slug"]

    if slug in seen_slugs:
        raise ValueError(f"Duplicate company slug: '{slug}'")

    if "name" not in entry or not entry["name"]:
        raise ValueError(f"Company '{slug}' missing 'name'")

    if "sources" not in entry or not entry["sources"]:
        raise ValueError(f"Company '{slug}' must have at least one source")

    seasonal_pattern = entry.get("seasonal_pattern")
    if seasonal_pattern is not None and (
        not isinstance(seasonal_pattern, str)
        or seasonal_pattern not in VALID_SEASONAL_PATTERNS
    ):
        raise ValueError(
            f"Company '{slug}' has invalid seasonal_pattern: {seasonal_pattern!r}"
        )

    for source in entry["sources"]:
        if "type" not in source:
            raise ValueError(f"Company '{slug}' has source missing 'type'")
        if source["type"] not in VALID_SOURCE_TYPES:
            raise ValueError(
                f"Company '{slug}' has unknown source type: '{source['type']}'"
            )
        if "board_token" not in source or not source["board_token"]:
            raise ValueError(f"Company '{slug}' has source missing 'board_token'")


def is_poll_due(
    company: Company,
    source_health: SourceHealth | None,
    now: datetime | None = None,
) -> bool:
    if now is None:
        now = datetime.now(UTC)

    if source_health is None or source_health.last_polled_at is None:
        return True

    last_polled = datetime.fromisoformat(source_health.last_polled_at)
    if last_polled.tzinfo is None:
        last_polled = last_polled.replace(tzinfo=UTC)
    elapsed = now - last_polled

    if _in_ramp_window(company, now):
        return True

    interval = _compute_interval(company, source_health, now)
    return elapsed >= interval


def _compute_interval(
    company: Company,
    source_health: SourceHealth,
    now: datetime,
) -> timedelta:
    if is_off_season(company, now):
        return OFF_SEASON_INTERVAL

    tier = get_activity_tier(source_health)
    if tier is not None:
        if tier == "hot":
            interval = HOT_INTERVAL
        elif tier == "active":
            interval = ACTIVE_INTERVAL
        else:
            interval = QUIET_INTERVAL

        if company.high_priority and interval > HIGH_PRIORITY_INTERVAL:
            interval = HIGH_PRIORITY_INTERVAL
        return interval

    return HIGH_PRIORITY_INTERVAL if company.high_priority else DEFAULT_INTERVAL


def is_off_season(company: Company, now: datetime) -> bool:
    pattern = company.seasonal_pattern
    if pattern is None or pattern == "year_round":
        return False
    if pattern == "fall":
        return now.month not in FALL_MONTHS
    if pattern == "spring":
        return now.month not in SPRING_MONTHS
    return False


def _in_ramp_window(company: Company, now: datetime) -> bool:
    if company.typical_open is None:
        return False

    try:
        parts = company.typical_open.split("-")
        year = int(parts[0])
        month = int(parts[1])
        typical_date = datetime(year, month, 1, tzinfo=UTC)
    except (ValueError, IndexError):
        logger.warning(
            "Company '%s' has invalid typical_open: '%s'",
            company.slug,
            company.typical_open,
        )
        return False

    window_start = typical_date - timedelta(days=RAMP_WINDOW_DAYS)
    window_end = typical_date + timedelta(days=RAMP_WINDOW_DAYS)
    return window_start <= now <= window_end


def get_activity_tier(source_health: SourceHealth | None) -> str | None:
    if source_health is None:
        return None
    if source_health.activity_poll_count < MIN_ADAPTIVE_POLLS:
        return None
    if source_health.consecutive_unchanged < HOT_THRESHOLD:
        return "hot"
    if source_health.consecutive_unchanged < ACTIVE_THRESHOLD:
        return "active"
    return "quiet"


def update_source_activity(
    health: SourceHealth,
    *,
    changed: bool,
    poll_duration: float,
    now: datetime,
    raw_id_hash: str | None = None,
) -> SourceHealth:
    count = health.activity_poll_count + 1
    now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    if count == 1:
        freq = 1.0 if changed else 0.0
        cost = poll_duration
    else:
        alpha = ACTIVITY_EMA_ALPHA
        freq = alpha * (1.0 if changed else 0.0) + (1 - alpha) * health.change_frequency
        cost = alpha * poll_duration + (1 - alpha) * health.estimated_poll_cost

    return dataclasses.replace(
        health,
        last_change_at=now_str if changed else health.last_change_at,
        consecutive_unchanged=0 if changed else health.consecutive_unchanged + 1,
        change_frequency=round(freq, 4),
        estimated_poll_cost=round(cost, 2),
        activity_poll_count=count,
        last_raw_id_hash=raw_id_hash if raw_id_hash is not None else health.last_raw_id_hash,
    )


def prioritize_due_sources(
    due_tasks: list[tuple[Company, SourceConfig]],
    sources: dict[str, SourceHealth],
    budget_seconds: float = 900.0,
) -> tuple[list[tuple[Company, SourceConfig]], list[tuple[Company, SourceConfig]]]:
    tier_order = {"hot": 0, "active": 1, "unknown": 2, "quiet": 3}

    def sort_key(task: tuple[Company, SourceConfig]) -> int:
        company, source = task
        key = f"{source.type}:{company.slug}"
        health = sources.get(key)
        tier = get_activity_tier(health) or "unknown"
        return tier_order.get(tier, 2)

    sorted_tasks = sorted(due_tasks, key=sort_key)

    budget_threshold = budget_seconds * 0.8
    cumulative_cost = 0.0
    prioritized: list[tuple[Company, SourceConfig]] = []
    deferred: list[tuple[Company, SourceConfig]] = []

    for task in sorted_tasks:
        company, source = task
        key = f"{source.type}:{company.slug}"
        health = sources.get(key)
        tier = get_activity_tier(health) or "unknown"
        cost = health.estimated_poll_cost if health else 0.0

        if tier == "quiet" and cumulative_cost + cost > budget_threshold:
            deferred.append(task)
        else:
            prioritized.append(task)
            cumulative_cost += cost

    return prioritized, deferred


def classify_tier_distribution(
    sources: dict[str, SourceHealth],
) -> dict[str, int]:
    distribution = {"hot": 0, "active": 0, "quiet": 0, "unknown": 0}
    for health in sources.values():
        tier = get_activity_tier(health)
        if tier is None:
            distribution["unknown"] += 1
        else:
            distribution[tier] += 1
    return distribution
