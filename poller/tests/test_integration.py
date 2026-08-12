from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest

from poller.exceptions import SourceFetchError
from poller.main import run_pipeline
from poller.models import (
    Company,
    Posting,
    RawPosting,
    SourceConfig,
    SourceHealth,
    compute_posting_id,
)
from poller.store import RunState, load_feed, load_state, save_feed, save_state
from poller.tests.conftest import make_company, make_posting, make_source_health

if TYPE_CHECKING:
    from pathlib import Path

ISO8601_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
)

REQUIRED_POSTING_FIELDS = {
    "id", "company", "company_slug", "title", "location", "locations",
    "url", "source", "source_job_id", "ats", "posted_at",
    "first_seen_at", "last_seen_at", "closed_at",
}


def _write_registry(path: Path, companies: list[Company]) -> None:
    import yaml

    entries: list[dict[str, Any]] = []
    for c in companies:
        entry: dict[str, Any] = {
            "slug": c.slug,
            "name": c.name,
            "tags": c.tags,
            "sources": [
                {"type": s.type, "board_token": s.board_token, "eu": s.eu}
                for s in c.sources
            ],
        }
        if c.typical_open:
            entry["typical_open"] = c.typical_open
        if c.high_priority:
            entry["high_priority"] = c.high_priority
        entries.append(entry)
    path.write_text(yaml.dump(entries), encoding="utf-8")


class _FakeAdapter:
    def __init__(
        self,
        postings: list[Posting],
        *,
        fail: bool = False,
        error_msg: str = "HTTP 500",
    ) -> None:
        self._postings = postings
        self._fail = fail
        self._error_msg = error_msg
        self.potentially_truncated = False

    async def fetch(
        self, client: Any, company: Any, source: Any,
    ) -> list[RawPosting]:
        if self._fail:
            raise SourceFetchError(
                source=source.type,
                company_slug=company.slug,
                message=self._error_msg,
            )
        raws = []
        for p in self._postings:
            raws.append(
                RawPosting(
                    source=p.source,
                    company_slug=p.company_slug,
                    source_job_id=p.source_job_id,
                    title=p.title,
                    location=p.location,
                    locations=list(p.locations),
                    url=p.url,
                    posted_at=p.posted_at,
                    description="Test description",
                )
            )
        return raws

    def normalize(
        self, raw: RawPosting, company: Any, now: str,
    ) -> Posting:
        for p in self._postings:
            if p.source_job_id == raw.source_job_id:
                return dataclasses.replace(
                    p, first_seen_at=now, last_seen_at=now,
                )
        msg = f"unexpected raw posting: {raw.source_job_id}"
        raise ValueError(msg)


def _seed_state(
    state_path: Path,
    sources: dict[str, SourceHealth] | None = None,
    run_count: int = 1,
    active_ids: set[str] | None = None,
    absent_ids: dict[str, str] | None = None,
) -> None:
    state = RunState(
        last_run_at="2026-09-01T00:00:00Z",
        run_count=run_count,
        sources=sources or {},
        active_ids=active_ids or set(),
        absent_ids=absent_ids or {},
    )
    save_state(state_path, state)


def _is_valid_iso(value: str | None) -> bool:
    if value is None:
        return True
    return bool(ISO8601_RE.match(value))


@pytest.mark.asyncio()
class TestSchemaContract:
    async def test_all_postings_have_required_fields(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(slug="acme", source_type="greenhouse")
        _write_registry(registry_path, [company])

        postings = [
            make_posting(
                pid=compute_posting_id("greenhouse", "acme", str(i)),
                company_slug="acme",
                source="greenhouse",
                source_job_id=str(i),
                title=f"Role {i}",
            )
            for i in range(5)
        ]
        adapter = _FakeAdapter(postings)

        with patch("poller.main.get_adapter", return_value=adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed_bytes = (data_dir / "feed.json").read_bytes()
        feed_data = json.loads(feed_bytes)

        assert "updated_at" in feed_data
        assert _is_valid_iso(feed_data["updated_at"])
        assert feed_data["version"] == 1
        assert feed_data["count"] == len(feed_data["postings"])

        for pid, posting_dict in feed_data["postings"].items():
            missing = REQUIRED_POSTING_FIELDS - set(posting_dict.keys())
            assert not missing, f"Posting {pid} missing fields: {missing}"

            assert "description_text" not in posting_dict, (
                f"Posting {pid} has description_text in feed.json"
            )

            expected_id = compute_posting_id(
                posting_dict["source"],
                posting_dict["company_slug"],
                posting_dict["source_job_id"],
            )
            assert posting_dict["id"] == expected_id, (
                f"Posting {pid}: id mismatch "
                f"({posting_dict['id']} != {expected_id})"
            )

            for ts_field in [
                "posted_at", "first_seen_at", "last_seen_at", "closed_at",
            ]:
                assert _is_valid_iso(posting_dict.get(ts_field)), (
                    f"Posting {pid}: {ts_field} is not valid ISO 8601: "
                    f"{posting_dict.get(ts_field)}"
                )


@pytest.mark.asyncio()
class TestMetaIntegrity:
    async def test_meta_sha256_matches_feed(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(slug="acme", source_type="lever")
        _write_registry(registry_path, [company])

        postings = [
            make_posting(
                pid=compute_posting_id("lever", "acme", "j1"),
                company_slug="acme",
                source="lever",
                source_job_id="j1",
            ),
        ]
        adapter = _FakeAdapter(postings)

        with patch("poller.main.get_adapter", return_value=adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed_bytes = (data_dir / "feed.json").read_bytes()
        meta_data = json.loads(
            (data_dir / "meta.json").read_text(encoding="utf-8"),
        )

        expected_sha = hashlib.sha256(feed_bytes).hexdigest()
        assert meta_data["sha256"] == expected_sha

        feed_data = json.loads(feed_bytes)
        assert meta_data["count"] == len(feed_data["postings"])
        assert meta_data["updated_at"] == feed_data["updated_at"]
        assert _is_valid_iso(meta_data["updated_at"])


@pytest.mark.asyncio()
class TestFlappingFullCycle:
    async def test_two_miss_flapping_guard(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(slug="acme", source_type="ashby")
        _write_registry(registry_path, [company])

        posting_a = make_posting(
            pid=compute_posting_id("ashby", "acme", "j1"),
            company_slug="acme",
            source="ashby",
            source_job_id="j1",
            title="Stable Role",
        )
        posting_x = make_posting(
            pid=compute_posting_id("ashby", "acme", "j2"),
            company_slug="acme",
            source="ashby",
            source_job_id="j2",
            title="Flapping Role",
        )

        # --- Run 1: both postings present (bootstrap) ---
        adapter = _FakeAdapter([posting_a, posting_x])
        with patch("poller.main.get_adapter", return_value=adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")
        assert posting_x.id in feed
        assert feed[posting_x.id].closed_at is None

        # --- Run 2: posting X disappears (miss 1) ---
        adapter = _FakeAdapter([posting_a])
        with (
            patch("poller.main.get_adapter", return_value=adapter),
            patch("poller.main.is_poll_due", return_value=True),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")
        assert posting_x.id in feed
        assert feed[posting_x.id].closed_at is None

        state = load_state(data_dir / "state.json")
        assert posting_x.id in state.absent_ids

        # --- Run 3: posting X still absent (miss 2, closed_at set) ---
        adapter = _FakeAdapter([posting_a])
        with (
            patch("poller.main.get_adapter", return_value=adapter),
            patch("poller.main.is_poll_due", return_value=True),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")
        assert posting_x.id in feed
        assert feed[posting_x.id].closed_at is not None

        # --- Run 4: 8 days later, posting X expired ---
        mock_dt_8d = datetime(2026, 10, 1, 0, 0, 0, tzinfo=UTC)

        adapter = _FakeAdapter([posting_a])
        with (
            patch("poller.main.get_adapter", return_value=adapter),
            patch("poller.main.is_poll_due", return_value=True),
            patch("poller.main.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = mock_dt_8d
            mock_dt.strftime = datetime.strftime
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")
        assert posting_x.id not in feed
        assert posting_a.id in feed


@pytest.mark.asyncio()
class TestBootstrapSuppression:
    async def test_first_fetch_suppresses_new_count(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = make_company(slug="acme", source_type="greenhouse")
        _write_registry(registry_path, [company])

        initial_posts = [
            make_posting(
                pid=compute_posting_id("greenhouse", "acme", str(i)),
                company_slug="acme",
                source="greenhouse",
                source_job_id=str(i),
                title=f"Role {i}",
            )
            for i in range(3)
        ]

        adapter = _FakeAdapter(initial_posts)
        with patch("poller.main.get_adapter", return_value=adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        state = load_state(data_dir / "state.json")
        gh_health = state.sources.get("greenhouse:acme")
        assert gh_health is not None
        assert gh_health.bootstrapped is True

        feed = load_feed(data_dir / "feed.json")
        assert len(feed) == 3

        # --- Run 2: add one new posting ---
        new_posting = make_posting(
            pid=compute_posting_id("greenhouse", "acme", "new_99"),
            company_slug="acme",
            source="greenhouse",
            source_job_id="new_99",
            title="Brand New Role",
        )
        adapter2 = _FakeAdapter(initial_posts + [new_posting])

        with (
            patch("poller.main.get_adapter", return_value=adapter2),
            patch("poller.main.is_poll_due", return_value=True),
        ):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed2 = load_feed(data_dir / "feed.json")
        assert len(feed2) == 4
        assert new_posting.id in feed2


@pytest.mark.asyncio()
class TestDedupeAcrossSources:
    async def test_cross_source_dedupe(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        company = Company(
            slug="acme",
            name="Acme",
            tags=["tech"],
            sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
                SourceConfig(type="lever", board_token="acme"),
            ],
        )
        _write_registry(registry_path, [company])

        gh_posting = make_posting(
            pid=compute_posting_id("greenhouse", "acme", "gh_100"),
            company="Acme",
            company_slug="acme",
            source="greenhouse",
            source_job_id="gh_100",
            title="Software Engineering Intern",
            location="New York, NY",
            locations=["New York, NY"],
        )
        lv_posting = make_posting(
            pid=compute_posting_id("lever", "acme", "lv_200"),
            company="Acme",
            company_slug="acme",
            source="lever",
            source_job_id="lv_200",
            title="Software Engineering Intern",
            location="New York, NY",
            locations=["New York, NY"],
            first_seen="2026-08-01T00:00:00Z",
        )

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            if source_type == "greenhouse":
                return _FakeAdapter([gh_posting])
            return _FakeAdapter([lv_posting])

        with patch("poller.main.get_adapter", side_effect=fake_get_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")

        assert gh_posting.id in feed or lv_posting.id in feed
        assert not (gh_posting.id in feed and lv_posting.id in feed), (
            "Both postings survived — dedupe should have merged them"
        )

        canonical_id = (
            gh_posting.id if gh_posting.id in feed else lv_posting.id
        )
        canonical = feed[canonical_id]
        assert canonical.source == "greenhouse"
        assert len(canonical.merged_from) == 1


@pytest.mark.asyncio()
class TestConcurrentAdapterFailure:
    async def test_two_failures_one_success(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        gh_company = make_company(
            slug="alpha", name="Alpha", source_type="greenhouse",
            board_token="alpha",
        )
        lv_company = make_company(
            slug="beta", name="Beta", source_type="lever",
            board_token="beta",
        )
        ab_company = make_company(
            slug="gamma", name="Gamma", source_type="ashby",
            board_token="gamma",
        )
        _write_registry(
            registry_path, [gh_company, lv_company, ab_company],
        )

        surviving_post = make_posting(
            pid="surviving_1",
            company="Beta",
            company_slug="beta",
            source="lever",
            source_job_id="2001",
        )

        gh_adapter = _FakeAdapter([], fail=True, error_msg="HTTP 500")
        lv_adapter = _FakeAdapter([surviving_post])
        ab_adapter = _FakeAdapter(
            [], fail=True, error_msg="Connection refused",
        )

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return {
                "greenhouse": gh_adapter,
                "lever": lv_adapter,
                "ashby": ab_adapter,
            }[source_type]

        with patch("poller.main.get_adapter", side_effect=fake_get_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")
        state = load_state(data_dir / "state.json")

        lever_ids = {
            pid for pid, p in feed.items() if p.source == "lever"
        }
        assert len(lever_ids) >= 1

        gh_health = state.sources.get("greenhouse:alpha")
        assert gh_health is not None
        assert gh_health.healthy is False
        assert gh_health.error is not None

        ab_health = state.sources.get("ashby:gamma")
        assert ab_health is not None
        assert ab_health.healthy is False
        assert ab_health.error is not None

        lv_health = state.sources.get("lever:beta")
        assert lv_health is not None
        assert lv_health.healthy is True

    async def test_failed_adapters_retain_previous_postings(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        gh_company = make_company(
            slug="alpha", name="Alpha", source_type="greenhouse",
            board_token="alpha",
        )
        lv_company = make_company(
            slug="beta", name="Beta", source_type="lever",
            board_token="beta",
        )
        _write_registry(registry_path, [gh_company, lv_company])

        existing_gh = make_posting(
            pid="existing_gh",
            company="Alpha",
            company_slug="alpha",
            source="greenhouse",
            source_job_id="999",
        )
        existing_lv = make_posting(
            pid="existing_lv",
            company="Beta",
            company_slug="beta",
            source="lever",
            source_job_id="888",
        )

        save_feed(
            data_dir / "feed.json",
            {existing_gh.id: existing_gh, existing_lv.id: existing_lv},
            "2026-08-30T00:00:00Z",
        )
        _seed_state(
            data_dir / "state.json",
            sources={
                "greenhouse:alpha": make_source_health(bootstrapped=True),
                "lever:beta": make_source_health(bootstrapped=True),
            },
            active_ids={existing_gh.id, existing_lv.id},
        )

        gh_adapter = _FakeAdapter([], fail=True, error_msg="timeout")
        lv_adapter = _FakeAdapter([], fail=True, error_msg="DNS failure")

        def fake_get_adapter(source_type: str) -> _FakeAdapter:
            return {
                "greenhouse": gh_adapter,
                "lever": lv_adapter,
            }[source_type]

        with patch("poller.main.get_adapter", side_effect=fake_get_adapter):
            await run_pipeline(
                dry_run=True,
                registry_path=registry_path,
                data_dir=data_dir,
            )

        feed = load_feed(data_dir / "feed.json")
        assert existing_gh.id in feed
        assert existing_lv.id in feed
        assert feed[existing_gh.id].closed_at is None
        assert feed[existing_lv.id].closed_at is None
