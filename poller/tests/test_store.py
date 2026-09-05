from __future__ import annotations

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

from poller.models import Posting, SourceHealth
from poller.store import (
    FEED_VERSION,
    RunState,
    load_feed,
    load_state,
    save_feed,
    save_meta,
    save_state,
)


def _make_posting(
    pid: str = "abc123",
    company: str = "Acme",
    company_slug: str = "acme",
    title: str = "SWE Intern",
    source: str = "greenhouse",
    source_job_id: str = "100",
    first_seen: str = "2026-09-01T00:00:00Z",
    last_seen: str = "2026-09-01T00:00:00Z",
    closed_at: str | None = None,
) -> Posting:
    return Posting(
        id=pid,
        company=company,
        company_slug=company_slug,
        title=title,
        location="New York, NY",
        locations=["New York, NY"],
        url=f"https://boards.greenhouse.io/{company_slug}/jobs/{source_job_id}",
        source=source,
        source_job_id=source_job_id,
        ats=source,
        posted_at="2026-09-01T00:00:00Z",
        first_seen_at=first_seen,
        last_seen_at=last_seen,
        closed_at=closed_at,
    )


class TestLoadFeed:
    def test_missing_file_returns_empty(self, tmp_path: Path) -> None:
        result = load_feed(tmp_path / "feed.json")
        assert result == {}

    def test_empty_file_returns_empty(self, tmp_path: Path) -> None:
        path = tmp_path / "feed.json"
        path.write_text("", encoding="utf-8")
        result = load_feed(path)
        assert result == {}

    def test_whitespace_only_returns_empty(self, tmp_path: Path) -> None:
        path = tmp_path / "feed.json"
        path.write_text("   \n  ", encoding="utf-8")
        result = load_feed(path)
        assert result == {}

    def test_loads_postings_by_id(self, tmp_path: Path) -> None:
        p = _make_posting()
        feed_data = {
            "updated_at": "2026-09-01T00:00:00Z",
            "version": 1,
            "count": 1,
            "postings": {p.id: p.to_dict()},
        }
        path = tmp_path / "feed.json"
        path.write_text(json.dumps(feed_data), encoding="utf-8")

        result = load_feed(path)
        assert len(result) == 1
        assert result[p.id].id == p.id
        assert result[p.id].company == "Acme"
        assert result[p.id].title == "SWE Intern"

    def test_loads_multiple_postings(self, tmp_path: Path) -> None:
        p1 = _make_posting(pid="aaa111", source_job_id="1")
        p2 = _make_posting(pid="bbb222", source_job_id="2", title="ML Intern")
        feed_data = {
            "updated_at": "2026-09-01T00:00:00Z",
            "version": 1,
            "count": 2,
            "postings": {
                p1.id: p1.to_dict(),
                p2.id: p2.to_dict(),
            },
        }
        path = tmp_path / "feed.json"
        path.write_text(json.dumps(feed_data), encoding="utf-8")

        result = load_feed(path)
        assert len(result) == 2
        assert "aaa111" in result
        assert "bbb222" in result


class TestSaveFeed:
    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        path = tmp_path / "data" / "feed.json"
        save_feed(path, {}, "2026-09-01T00:00:00Z")
        assert path.exists()

    def test_writes_correct_structure(self, tmp_path: Path) -> None:
        p = _make_posting()
        path = tmp_path / "feed.json"
        save_feed(path, {p.id: p}, "2026-09-15T00:00:00Z")

        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["updated_at"] == "2026-09-15T00:00:00Z"
        assert data["version"] == FEED_VERSION
        assert data["count"] == 1
        assert p.id in data["postings"]

    def test_empty_feed_writes_zero_count(self, tmp_path: Path) -> None:
        path = tmp_path / "feed.json"
        save_feed(path, {}, "2026-09-01T00:00:00Z")

        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["count"] == 0
        assert data["postings"] == {}

    def test_trailing_newline(self, tmp_path: Path) -> None:
        path = tmp_path / "feed.json"
        save_feed(path, {}, "2026-09-01T00:00:00Z")
        text = path.read_text(encoding="utf-8")
        assert text.endswith("\n")
        assert not text.endswith("\n\n")

    def test_sorted_posting_keys(self, tmp_path: Path) -> None:
        p1 = _make_posting(pid="zzz999", source_job_id="1")
        p2 = _make_posting(pid="aaa111", source_job_id="2")
        path = tmp_path / "feed.json"
        save_feed(path, {p1.id: p1, p2.id: p2}, "2026-09-01T00:00:00Z")

        data = json.loads(path.read_text(encoding="utf-8"))
        keys = list(data["postings"].keys())
        assert keys == sorted(keys)

    def test_deterministic_output(self, tmp_path: Path) -> None:
        p1 = _make_posting(pid="bbb222", source_job_id="1")
        p2 = _make_posting(pid="aaa111", source_job_id="2")
        postings = {p1.id: p1, p2.id: p2}
        ts = "2026-09-01T00:00:00Z"

        path1 = tmp_path / "feed1.json"
        path2 = tmp_path / "feed2.json"
        save_feed(path1, postings, ts)
        save_feed(path2, postings, ts)

        assert path1.read_bytes() == path2.read_bytes()


class TestFeedRoundTrip:
    def test_round_trip_single_posting(self, tmp_path: Path) -> None:
        p = _make_posting()
        path = tmp_path / "feed.json"
        save_feed(path, {p.id: p}, "2026-09-01T00:00:00Z")

        loaded = load_feed(path)
        assert loaded[p.id].to_dict() == p.to_dict()

    def test_round_trip_with_optional_fields(self, tmp_path: Path) -> None:
        p = Posting(
            id="abc123",
            company="Acme",
            company_slug="acme",
            title="SWE Intern",
            location="New York, NY",
            locations=["New York, NY"],
            url="https://boards.greenhouse.io/acme/jobs/100",
            source="greenhouse",
            source_job_id="100",
            ats="greenhouse",
            posted_at="2026-09-01T00:00:00Z",
            first_seen_at="2026-09-01T00:00:00Z",
            last_seen_at="2026-09-01T00:00:00Z",
            closed_at="2026-09-10T00:00:00Z",
            compensation="$40/hr",
            merged_from=["other_id_1", "other_id_2"],
            description_text="Build cool stuff",
        )
        path = tmp_path / "feed.json"
        save_feed(path, {p.id: p}, "2026-09-01T00:00:00Z")

        loaded = load_feed(path)
        lp = loaded[p.id]
        assert lp.closed_at == "2026-09-10T00:00:00Z"
        assert lp.compensation == "$40/hr"
        assert lp.merged_from == ["other_id_1", "other_id_2"]
        assert lp.description_text == "Build cool stuff"

    def test_round_trip_preserves_byte_stability(self, tmp_path: Path) -> None:
        p1 = _make_posting(pid="ccc333", source_job_id="3")
        p2 = _make_posting(pid="aaa111", source_job_id="1")
        postings = {p1.id: p1, p2.id: p2}
        ts = "2026-09-01T00:00:00Z"
        path = tmp_path / "feed.json"

        save_feed(path, postings, ts)
        bytes_first = path.read_bytes()

        loaded = load_feed(path)
        save_feed(path, loaded, ts)
        bytes_second = path.read_bytes()

        assert bytes_first == bytes_second


class TestLoadState:
    def test_missing_file_returns_default(self, tmp_path: Path) -> None:
        state = load_state(tmp_path / "state.json")
        assert state.last_run_at is None
        assert state.run_count == 0
        assert state.sources == {}
        assert state.active_ids == set()
        assert state.absent_ids == {}

    def test_empty_file_returns_default(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        path.write_text("", encoding="utf-8")
        state = load_state(path)
        assert state.run_count == 0

    def test_loads_all_fields(self, tmp_path: Path) -> None:
        state_data = {
            "last_run_at": "2026-09-01T00:00:00Z",
            "run_count": 5,
            "sources": {
                "greenhouse:acme": {
                    "last_polled_at": "2026-09-01T00:00:00Z",
                    "healthy": True,
                    "error": None,
                    "bootstrapped": True,
                    "potentially_truncated": False,
                }
            },
            "active_ids": ["aaa111", "bbb222"],
            "absent_ids": {"ccc333": "2026-08-31T00:00:00Z"},
        }
        path = tmp_path / "state.json"
        path.write_text(json.dumps(state_data), encoding="utf-8")

        state = load_state(path)
        assert state.last_run_at == "2026-09-01T00:00:00Z"
        assert state.run_count == 5
        assert "greenhouse:acme" in state.sources
        sh = state.sources["greenhouse:acme"]
        assert sh.bootstrapped is True
        assert sh.healthy is True
        assert state.active_ids == {"aaa111", "bbb222"}
        assert state.absent_ids == {"ccc333": "2026-08-31T00:00:00Z"}

    def test_loads_unhealthy_source(self, tmp_path: Path) -> None:
        state_data = {
            "sources": {
                "lever:badco": {
                    "last_polled_at": "2026-09-01T00:00:00Z",
                    "healthy": False,
                    "error": "HTTP 500",
                    "bootstrapped": False,
                    "potentially_truncated": True,
                }
            },
        }
        path = tmp_path / "state.json"
        path.write_text(json.dumps(state_data), encoding="utf-8")

        state = load_state(path)
        sh = state.sources["lever:badco"]
        assert sh.healthy is False
        assert sh.error == "HTTP 500"
        assert sh.potentially_truncated is True


class TestSaveState:
    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        path = tmp_path / "data" / "state.json"
        save_state(path, RunState())
        assert path.exists()

    def test_trailing_newline(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        save_state(path, RunState())
        text = path.read_text(encoding="utf-8")
        assert text.endswith("\n")
        assert not text.endswith("\n\n")

    def test_sorted_source_keys(self, tmp_path: Path) -> None:
        state = RunState(
            sources={
                "lever:zzz": SourceHealth(),
                "ashby:aaa": SourceHealth(),
                "greenhouse:mmm": SourceHealth(),
            }
        )
        path = tmp_path / "state.json"
        save_state(path, state)

        data = json.loads(path.read_text(encoding="utf-8"))
        keys = list(data["sources"].keys())
        assert keys == sorted(keys)

    def test_sorted_active_ids(self, tmp_path: Path) -> None:
        state = RunState(active_ids={"zzz", "aaa", "mmm"})
        path = tmp_path / "state.json"
        save_state(path, state)

        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["active_ids"] == ["aaa", "mmm", "zzz"]

    def test_sorted_absent_ids(self, tmp_path: Path) -> None:
        state = RunState(
            absent_ids={
                "zzz": "2026-09-01T00:00:00Z",
                "aaa": "2026-09-02T00:00:00Z",
            }
        )
        path = tmp_path / "state.json"
        save_state(path, state)

        data = json.loads(path.read_text(encoding="utf-8"))
        keys = list(data["absent_ids"].keys())
        assert keys == sorted(keys)


class TestStateRoundTrip:
    def test_round_trip_default_state(self, tmp_path: Path) -> None:
        path = tmp_path / "state.json"
        original = RunState()
        save_state(path, original)
        loaded = load_state(path)

        assert loaded.last_run_at == original.last_run_at
        assert loaded.run_count == original.run_count
        assert loaded.sources == original.sources
        assert loaded.active_ids == original.active_ids
        assert loaded.absent_ids == original.absent_ids

    def test_round_trip_full_state(self, tmp_path: Path) -> None:
        original = RunState(
            last_run_at="2026-09-01T12:00:00Z",
            run_count=42,
            sources={
                "greenhouse:acme": SourceHealth(
                    last_polled_at="2026-09-01T12:00:00Z",
                    healthy=True,
                    bootstrapped=True,
                ),
                "lever:beta": SourceHealth(
                    last_polled_at="2026-09-01T11:00:00Z",
                    healthy=False,
                    error="timeout",
                    potentially_truncated=True,
                ),
            },
            active_ids={"aaa111", "bbb222", "ccc333"},
            absent_ids={
                "ddd444": "2026-09-01T06:00:00Z",
                "eee555": "2026-09-01T00:00:00Z",
            },
        )
        path = tmp_path / "state.json"
        save_state(path, original)
        loaded = load_state(path)

        assert loaded.last_run_at == original.last_run_at
        assert loaded.run_count == original.run_count
        assert loaded.active_ids == original.active_ids
        assert loaded.absent_ids == original.absent_ids
        assert set(loaded.sources.keys()) == set(original.sources.keys())

        for key in original.sources:
            orig_sh = original.sources[key]
            load_sh = loaded.sources[key]
            assert load_sh.last_polled_at == orig_sh.last_polled_at
            assert load_sh.healthy == orig_sh.healthy
            assert load_sh.error == orig_sh.error
            assert load_sh.bootstrapped == orig_sh.bootstrapped
            assert (
                load_sh.potentially_truncated == orig_sh.potentially_truncated
            )

    def test_round_trip_byte_stability(self, tmp_path: Path) -> None:
        state = RunState(
            last_run_at="2026-09-01T12:00:00Z",
            run_count=10,
            sources={"greenhouse:acme": SourceHealth(bootstrapped=True)},
            active_ids={"bbb", "aaa"},
            absent_ids={"ccc": "2026-09-01T00:00:00Z"},
        )
        path = tmp_path / "state.json"

        save_state(path, state)
        bytes_first = path.read_bytes()

        loaded = load_state(path)
        save_state(path, loaded)
        bytes_second = path.read_bytes()

        assert bytes_first == bytes_second


class TestRunStateToDict:
    def test_active_ids_serialized_as_sorted_list(self) -> None:
        state = RunState(active_ids={"zzz", "aaa", "mmm"})
        d = state.to_dict()
        assert d["active_ids"] == ["aaa", "mmm", "zzz"]
        assert isinstance(d["active_ids"], list)

    def test_absent_ids_serialized_as_sorted_dict(self) -> None:
        state = RunState(
            absent_ids={"zzz": "t1", "aaa": "t2"}
        )
        d = state.to_dict()
        keys = list(d["absent_ids"].keys())
        assert keys == ["aaa", "zzz"]


class TestSaveMeta:
    def test_writes_correct_sha256(self, tmp_path: Path) -> None:
        import hashlib

        p = _make_posting()
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        save_feed(feed_path, {p.id: p}, "2026-09-01T00:00:00Z")

        save_meta(meta_path, feed_path, "2026-09-01T00:00:00Z", 1)

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        expected_sha = hashlib.sha256(feed_path.read_bytes()).hexdigest()
        assert meta["sha256"] == expected_sha

    def test_writes_correct_count(self, tmp_path: Path) -> None:
        p = _make_posting()
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        save_feed(feed_path, {p.id: p}, "2026-09-01T00:00:00Z")

        save_meta(meta_path, feed_path, "2026-09-01T00:00:00Z", 1)

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        assert meta["count"] == 1

    def test_writes_updated_at(self, tmp_path: Path) -> None:
        p = _make_posting()
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        save_feed(feed_path, {p.id: p}, "2026-09-15T12:00:00Z")

        save_meta(meta_path, feed_path, "2026-09-15T12:00:00Z", 1)

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        assert meta["updated_at"] == "2026-09-15T12:00:00Z"

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        p = _make_posting()
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "nested" / "meta.json"
        save_feed(feed_path, {p.id: p}, "2026-09-01T00:00:00Z")

        save_meta(meta_path, feed_path, "2026-09-01T00:00:00Z", 1)

        assert meta_path.exists()

    def test_trailing_newline(self, tmp_path: Path) -> None:
        p = _make_posting()
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        save_feed(feed_path, {p.id: p}, "2026-09-01T00:00:00Z")

        save_meta(meta_path, feed_path, "2026-09-01T00:00:00Z", 1)

        text = meta_path.read_text(encoding="utf-8")
        assert text.endswith("\n")
        assert not text.endswith("\n\n")
