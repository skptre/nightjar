from __future__ import annotations

from datetime import UTC, datetime, timedelta
from textwrap import dedent
from typing import TYPE_CHECKING

import pytest

from poller.models import Company, SourceConfig, SourceHealth
from poller.registry import is_poll_due, load_registry

if TYPE_CHECKING:
    from pathlib import Path


def _company(
    *,
    seasonal_pattern: str | None,
    high_priority: bool = True,
    typical_open: str | None = None,
) -> Company:
    return Company(
        slug="acme",
        name="Acme",
        tags=["tech"],
        sources=[SourceConfig(type="greenhouse", board_token="acme")],
        typical_open=typical_open,
        high_priority=high_priority,
        seasonal_pattern=seasonal_pattern,
    )


def _health(now: datetime, elapsed: timedelta) -> SourceHealth:
    return SourceHealth(last_polled_at=(now - elapsed).isoformat())


class TestSeasonalRegistryLoading:
    def test_loads_each_supported_pattern(self, tmp_path: Path) -> None:
        path = tmp_path / "companies.yaml"
        path.write_text(
            dedent(
                """\
                - slug: fall-co
                  name: Fall Co
                  tags: [tech]
                  seasonal_pattern: fall
                  sources:
                    - type: greenhouse
                      board_token: fall-co
                - slug: spring-co
                  name: Spring Co
                  tags: [finance]
                  seasonal_pattern: spring
                  sources:
                    - type: lever
                      board_token: spring-co
                - slug: year-round-co
                  name: Year Round Co
                  tags: [government]
                  seasonal_pattern: year_round
                  sources:
                    - type: ashby
                      board_token: year-round-co
                """
            ),
            encoding="utf-8",
        )

        companies = load_registry(path)

        assert [company.seasonal_pattern for company in companies] == [
            "fall",
            "spring",
            "year_round",
        ]

    def test_missing_pattern_defaults_to_unknown(self, tmp_path: Path) -> None:
        path = tmp_path / "companies.yaml"
        path.write_text(
            dedent(
                """\
                - slug: acme
                  name: Acme
                  tags: [tech]
                  sources:
                    - type: greenhouse
                      board_token: acme
                """
            ),
            encoding="utf-8",
        )

        assert load_registry(path)[0].seasonal_pattern is None

    @pytest.mark.parametrize("value", ["summer", "", 42, ["fall"]])
    def test_invalid_pattern_is_rejected(self, tmp_path: Path, value: object) -> None:
        import yaml

        path = tmp_path / "companies.yaml"
        path.write_text(
            yaml.safe_dump(
                [
                    {
                        "slug": "acme",
                        "name": "Acme",
                        "tags": ["tech"],
                        "seasonal_pattern": value,
                        "sources": [
                            {"type": "greenhouse", "board_token": "acme"}
                        ],
                    }
                ],
                sort_keys=False,
            ),
            encoding="utf-8",
        )

        with pytest.raises(ValueError, match="seasonal_pattern"):
            load_registry(path)


class TestSeasonalPolling:
    def test_fall_high_priority_uses_30_minutes_in_season(self) -> None:
        now = datetime(2026, 9, 1, 12, tzinfo=UTC)
        company = _company(seasonal_pattern="fall")

        assert is_poll_due(company, _health(now, timedelta(minutes=31)), now) is True
        assert is_poll_due(company, _health(now, timedelta(minutes=29)), now) is False

    def test_fall_high_priority_is_capped_at_six_hours_off_season(self) -> None:
        now = datetime(2026, 2, 1, 12, tzinfo=UTC)
        company = _company(seasonal_pattern="fall")

        assert is_poll_due(company, _health(now, timedelta(hours=4)), now) is False
        assert is_poll_due(company, _health(now, timedelta(hours=7)), now) is True

    def test_spring_mapping_includes_december_through_april(self) -> None:
        company = _company(seasonal_pattern="spring")

        for month in (12, 1, 2, 3, 4):
            now = datetime(2026 if month == 12 else 2027, month, 1, tzinfo=UTC)
            assert is_poll_due(
                company, _health(now, timedelta(minutes=31)), now
            ) is True

    def test_spring_mapping_excludes_may_through_november(self) -> None:
        company = _company(seasonal_pattern="spring")

        for month in range(5, 12):
            now = datetime(2026, month, 1, tzinfo=UTC)
            assert is_poll_due(
                company, _health(now, timedelta(hours=4)), now
            ) is False

    def test_year_round_preserves_high_priority_interval(self) -> None:
        company = _company(seasonal_pattern="year_round")

        for month in range(1, 13):
            now = datetime(2026, month, 1, tzinfo=UTC)
            assert is_poll_due(
                company, _health(now, timedelta(minutes=31)), now
            ) is True

    def test_unknown_pattern_preserves_existing_logic(self) -> None:
        now = datetime(2026, 2, 1, 12, tzinfo=UTC)
        company = _company(seasonal_pattern=None)

        assert is_poll_due(company, _health(now, timedelta(minutes=31)), now) is True

    def test_ramp_window_overrides_off_season(self) -> None:
        now = datetime(2026, 6, 25, 12, tzinfo=UTC)
        company = _company(
            seasonal_pattern="spring",
            high_priority=False,
            typical_open="2026-07",
        )

        assert is_poll_due(company, _health(now, timedelta(minutes=1)), now) is True

    def test_default_priority_remains_six_hours_in_and_out_of_season(self) -> None:
        company = _company(seasonal_pattern="fall", high_priority=False)

        for now in (
            datetime(2026, 9, 1, tzinfo=UTC),
            datetime(2026, 2, 1, tzinfo=UTC),
        ):
            assert is_poll_due(company, _health(now, timedelta(hours=5)), now) is False
            assert is_poll_due(company, _health(now, timedelta(hours=6)), now) is True
