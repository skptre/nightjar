from datetime import UTC, datetime, timedelta
from pathlib import Path
from textwrap import dedent

import pytest

from poller.models import Company, SourceConfig, SourceHealth
from poller.registry import is_poll_due, load_registry


@pytest.fixture()
def registry_dir(tmp_path: Path) -> Path:
    return tmp_path


def _write_yaml(path: Path, content: str) -> Path:
    f = path / "companies.yaml"
    f.write_text(dedent(content), encoding="utf-8")
    return f


class TestLoadRegistry:
    def test_valid_yaml_loads_all_companies(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: ramp
              name: Ramp
              tags: [fintech]
              sources:
                - type: greenhouse
                  board_token: ramp
            - slug: linear
              name: Linear
              tags: [devtools]
              sources:
                - type: ashby
                  board_token: linear
            """,
        )
        companies = load_registry(f)
        assert len(companies) == 2
        assert companies[0].slug == "ramp"
        assert companies[1].slug == "linear"

    def test_source_config_fields(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: test
              name: Test Co
              tags: []
              sources:
                - type: lever
                  board_token: testco
                  eu: true
            """,
        )
        companies = load_registry(f)
        src = companies[0].sources[0]
        assert src.type == "lever"
        assert src.board_token == "testco"
        assert src.eu is True

    def test_eu_defaults_false(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: test
              name: Test Co
              tags: []
              sources:
                - type: lever
                  board_token: testco
            """,
        )
        companies = load_registry(f)
        assert companies[0].sources[0].eu is False

    def test_optional_fields_default(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: test
              name: Test Co
              tags: [startup]
              sources:
                - type: greenhouse
                  board_token: test
            """,
        )
        companies = load_registry(f)
        c = companies[0]
        assert c.typical_open is None
        assert c.high_priority is False

    def test_high_priority_and_typical_open(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: test
              name: Test Co
              tags: [startup]
              sources:
                - type: greenhouse
                  board_token: test
              typical_open: "2026-09"
              high_priority: true
            """,
        )
        companies = load_registry(f)
        c = companies[0]
        assert c.typical_open == "2026-09"
        assert c.high_priority is True

    def test_missing_slug_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - name: No Slug Corp
              tags: []
              sources:
                - type: greenhouse
                  board_token: noslug
            """,
        )
        with pytest.raises(ValueError, match="missing 'slug'"):
            load_registry(f)

    def test_empty_slug_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: ""
              name: Empty Slug
              tags: []
              sources:
                - type: greenhouse
                  board_token: empty
            """,
        )
        with pytest.raises(ValueError, match="missing 'slug'"):
            load_registry(f)

    def test_duplicate_slug_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: dupe
              name: First
              tags: []
              sources:
                - type: greenhouse
                  board_token: first
            - slug: dupe
              name: Second
              tags: []
              sources:
                - type: greenhouse
                  board_token: second
            """,
        )
        with pytest.raises(ValueError, match="Duplicate company slug.*dupe"):
            load_registry(f)

    def test_missing_name_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: noname
              tags: []
              sources:
                - type: greenhouse
                  board_token: noname
            """,
        )
        with pytest.raises(ValueError, match="missing 'name'"):
            load_registry(f)

    def test_no_sources_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: nosrc
              name: No Sources
              tags: []
              sources: []
            """,
        )
        with pytest.raises(ValueError, match="must have at least one source"):
            load_registry(f)

    def test_unknown_source_type_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: bad
              name: Bad Type
              tags: []
              sources:
                - type: indeed
                  board_token: bad
            """,
        )
        with pytest.raises(ValueError, match="unknown source type.*indeed"):
            load_registry(f)

    def test_missing_board_token_raises(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: notoken
              name: No Token
              tags: []
              sources:
                - type: greenhouse
            """,
        )
        with pytest.raises(ValueError, match="missing 'board_token'"):
            load_registry(f)

    def test_multiple_sources_per_company(self, registry_dir: Path) -> None:
        f = _write_yaml(
            registry_dir,
            """\
            - slug: multi
              name: Multi Source
              tags: []
              sources:
                - type: greenhouse
                  board_token: multi-gh
                - type: lever
                  board_token: multi-lever
            """,
        )
        companies = load_registry(f)
        assert len(companies[0].sources) == 2

    def test_loads_real_registry(self) -> None:
        companies = load_registry()
        assert len(companies) >= 25
        slugs = [c.slug for c in companies]
        assert len(slugs) == len(set(slugs))
        for c in companies:
            assert c.name
            assert len(c.sources) >= 1
            for s in c.sources:
                assert s.type in {"greenhouse", "lever", "ashby", "workday", "smartrecruiters"}
                assert s.board_token


class TestIsPollDue:
    def _make_company(
        self,
        high_priority: bool = False,
        typical_open: str | None = None,
    ) -> Company:
        return Company(
            slug="test",
            name="Test",
            tags=[],
            sources=[SourceConfig(type="greenhouse", board_token="test")],
            typical_open=typical_open,
            high_priority=high_priority,
        )

    def test_never_polled_always_due(self) -> None:
        company = self._make_company()
        assert is_poll_due(company, None) is True

    def test_no_last_polled_at_always_due(self) -> None:
        company = self._make_company()
        health = SourceHealth(last_polled_at=None)
        assert is_poll_due(company, health) is True

    def test_default_interval_not_due(self) -> None:
        company = self._make_company()
        now = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)
        five_hours_ago = (now - timedelta(hours=5)).isoformat()
        health = SourceHealth(last_polled_at=five_hours_ago)
        assert is_poll_due(company, health, now=now) is False

    def test_default_interval_due(self) -> None:
        company = self._make_company()
        now = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)
        seven_hours_ago = (now - timedelta(hours=7)).isoformat()
        health = SourceHealth(last_polled_at=seven_hours_ago)
        assert is_poll_due(company, health, now=now) is True

    def test_high_priority_30min_due(self) -> None:
        company = self._make_company(high_priority=True)
        now = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)
        thirty_one_min_ago = (now - timedelta(minutes=31)).isoformat()
        health = SourceHealth(last_polled_at=thirty_one_min_ago)
        assert is_poll_due(company, health, now=now) is True

    def test_high_priority_not_yet_due(self) -> None:
        company = self._make_company(high_priority=True)
        now = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)
        twenty_min_ago = (now - timedelta(minutes=20)).isoformat()
        health = SourceHealth(last_polled_at=twenty_min_ago)
        assert is_poll_due(company, health, now=now) is False

    def test_ramp_window_always_due(self) -> None:
        company = self._make_company(typical_open="2026-09")
        now = datetime(2026, 8, 25, 12, 0, 0, tzinfo=UTC)
        one_hour_ago = (now - timedelta(hours=1)).isoformat()
        health = SourceHealth(last_polled_at=one_hour_ago)
        assert is_poll_due(company, health, now=now) is True

    def test_outside_ramp_window_uses_default(self) -> None:
        company = self._make_company(typical_open="2026-09")
        now = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
        one_hour_ago = (now - timedelta(hours=1)).isoformat()
        health = SourceHealth(last_polled_at=one_hour_ago)
        assert is_poll_due(company, health, now=now) is False

    def test_ramp_window_boundary_start(self) -> None:
        company = self._make_company(typical_open="2026-09")
        window_start = datetime(2026, 8, 18, 0, 0, 0, tzinfo=UTC)
        one_min_ago = (window_start - timedelta(minutes=1)).isoformat()
        health = SourceHealth(last_polled_at=one_min_ago)
        assert is_poll_due(company, health, now=window_start) is True

    def test_no_typical_open_no_ramp(self) -> None:
        company = self._make_company(typical_open=None)
        now = datetime(2026, 8, 25, 12, 0, 0, tzinfo=UTC)
        one_hour_ago = (now - timedelta(hours=1)).isoformat()
        health = SourceHealth(last_polled_at=one_hour_ago)
        assert is_poll_due(company, health, now=now) is False

    def test_exactly_at_interval_boundary(self) -> None:
        company = self._make_company()
        now = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)
        exactly_6h_ago = (now - timedelta(hours=6)).isoformat()
        health = SourceHealth(last_polled_at=exactly_6h_ago)
        assert is_poll_due(company, health, now=now) is True
