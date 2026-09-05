from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

from poller.models import Posting
from poller.store import (
    SHARDING_THRESHOLD,
    load_feed,
    load_feed_sharded,
    save_feed,
    save_feed_sharded,
    save_meta,
)


def _make_posting(
    pid: str = "abc123",
    company_slug: str = "acme",
    source: str = "greenhouse",
    source_job_id: str = "100",
    title: str = "SWE Intern",
) -> Posting:
    return Posting(
        id=pid,
        company="Acme",
        company_slug=company_slug,
        title=title,
        location="New York, NY",
        locations=["New York, NY"],
        url=f"https://boards.greenhouse.io/{company_slug}/jobs/{source_job_id}",
        source=source,
        source_job_id=source_job_id,
        ats=source,
        posted_at="2026-09-01T00:00:00Z",
        first_seen_at="2026-09-01T00:00:00Z",
        last_seen_at="2026-09-01T00:00:00Z",
    )


TS = "2026-09-15T00:00:00Z"


class TestPartitionBySource:
    def test_single_source(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="greenhouse"),
        }
        hashes = save_feed_sharded(tmp_path / "feed", postings, TS)
        assert set(hashes.keys()) == {"greenhouse"}
        assert hashes["greenhouse"].count == 2

    def test_multiple_sources(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
            "c": _make_posting(pid="c", source="workday"),
            "d": _make_posting(pid="d", source="greenhouse"),
        }
        hashes = save_feed_sharded(tmp_path / "feed", postings, TS)
        assert set(hashes.keys()) == {"greenhouse", "lever", "workday"}
        assert hashes["greenhouse"].count == 2
        assert hashes["lever"].count == 1
        assert hashes["workday"].count == 1

    def test_empty_postings(self, tmp_path: Path) -> None:
        hashes = save_feed_sharded(tmp_path / "feed", {}, TS)
        assert hashes == {}
        index_path = tmp_path / "feed" / "index.json"
        assert index_path.exists()
        data = json.loads(index_path.read_text(encoding="utf-8"))
        assert data["total_count"] == 0
        assert data["shards"] == []


class TestShardFiles:
    def test_shard_file_structure(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="lever"),
        }
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS)

        shard_path = feed_dir / "lever.json"
        assert shard_path.exists()
        data = json.loads(shard_path.read_text(encoding="utf-8"))
        assert data["shard_id"] == "lever"
        assert data["updated_at"] == TS
        assert data["count"] == 1
        assert "a" in data["postings"]

    def test_index_file_structure(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
        }
        feed_dir = tmp_path / "feed"
        hashes = save_feed_sharded(feed_dir, postings, TS)

        index_path = feed_dir / "index.json"
        data = json.loads(index_path.read_text(encoding="utf-8"))
        assert data["version"] == 1
        assert data["updated_at"] == TS
        assert data["total_count"] == 2
        assert len(data["shards"]) == 2

        shard_ids = {s["id"] for s in data["shards"]}
        assert shard_ids == {"greenhouse", "lever"}

        for shard_entry in data["shards"]:
            sid = shard_entry["id"]
            assert shard_entry["sha256"] == hashes[sid].sha256
            assert shard_entry["count"] == hashes[sid].count

    def test_shard_trailing_newline(self, tmp_path: Path) -> None:
        postings = {"a": _make_posting(pid="a")}
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS)

        shard_text = (feed_dir / "greenhouse.json").read_text(encoding="utf-8")
        assert shard_text.endswith("\n")
        assert not shard_text.endswith("\n\n")

        index_text = (feed_dir / "index.json").read_text(encoding="utf-8")
        assert index_text.endswith("\n")
        assert not index_text.endswith("\n\n")

    def test_sorted_posting_keys_within_shard(self, tmp_path: Path) -> None:
        postings = {
            "zzz": _make_posting(pid="zzz", source="lever"),
            "aaa": _make_posting(pid="aaa", source="lever"),
            "mmm": _make_posting(pid="mmm", source="lever"),
        }
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS)

        data = json.loads((feed_dir / "lever.json").read_text(encoding="utf-8"))
        keys = list(data["postings"].keys())
        assert keys == sorted(keys)

    def test_sorted_shards_in_index(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="workday"),
            "b": _make_posting(pid="b", source="ashby"),
            "c": _make_posting(pid="c", source="greenhouse"),
        }
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS)

        data = json.loads((feed_dir / "index.json").read_text(encoding="utf-8"))
        shard_ids = [s["id"] for s in data["shards"]]
        assert shard_ids == sorted(shard_ids)

    def test_companies_in_index(self, tmp_path: Path) -> None:
        postings = {"a": _make_posting(pid="a")}
        companies = [
            type("Company", (), {"slug": "acme", "name": "Acme Corp", "typical_open": "2026-09"})(),
            type("Company", (), {"slug": "beta", "name": "Beta Inc", "typical_open": None})(),
        ]
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS, companies=companies)

        data = json.loads((feed_dir / "index.json").read_text(encoding="utf-8"))
        assert "companies" in data
        assert data["companies"]["acme"]["name"] == "Acme Corp"
        assert data["companies"]["beta"]["typical_open"] is None


class TestShardHashes:
    def test_sha256_matches_shard_bytes(self, tmp_path: Path) -> None:
        postings = {"a": _make_posting(pid="a", source="lever")}
        feed_dir = tmp_path / "feed"
        hashes = save_feed_sharded(feed_dir, postings, TS)

        shard_bytes = (feed_dir / "lever.json").read_bytes()
        expected_sha = hashlib.sha256(shard_bytes).hexdigest()
        assert hashes["lever"].sha256 == expected_sha

    def test_deterministic_output(self, tmp_path: Path) -> None:
        postings = {
            "b": _make_posting(pid="b", source="lever"),
            "a": _make_posting(pid="a", source="greenhouse"),
        }
        dir1 = tmp_path / "feed1"
        dir2 = tmp_path / "feed2"
        h1 = save_feed_sharded(dir1, postings, TS)
        h2 = save_feed_sharded(dir2, postings, TS)

        for sid in h1:
            assert h1[sid].sha256 == h2[sid].sha256
            assert (dir1 / f"{sid}.json").read_bytes() == (dir2 / f"{sid}.json").read_bytes()


class TestStaleShardCleanup:
    def test_removes_stale_shard_files(self, tmp_path: Path) -> None:
        feed_dir = tmp_path / "feed"
        feed_dir.mkdir()
        stale = feed_dir / "old_source.json"
        stale.write_text("{}", encoding="utf-8")

        postings = {"a": _make_posting(pid="a", source="greenhouse")}
        save_feed_sharded(feed_dir, postings, TS)

        assert not stale.exists()
        assert (feed_dir / "greenhouse.json").exists()
        assert (feed_dir / "index.json").exists()

    def test_preserves_index_file(self, tmp_path: Path) -> None:
        feed_dir = tmp_path / "feed"
        postings = {"a": _make_posting(pid="a", source="lever")}
        save_feed_sharded(feed_dir, postings, TS)

        postings2 = {"b": _make_posting(pid="b", source="greenhouse")}
        save_feed_sharded(feed_dir, postings2, TS)

        assert not (feed_dir / "lever.json").exists()
        assert (feed_dir / "greenhouse.json").exists()
        assert (feed_dir / "index.json").exists()


class TestShardedRoundTrip:
    def test_round_trip_single_source(self, tmp_path: Path) -> None:
        p = _make_posting(pid="abc", source="lever")
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, {p.id: p}, TS)

        loaded = load_feed_sharded(feed_dir)
        assert len(loaded) == 1
        assert loaded["abc"].to_dict() == p.to_dict()

    def test_round_trip_multiple_sources(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
            "c": _make_posting(pid="c", source="workday"),
        }
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS)

        loaded = load_feed_sharded(feed_dir)
        assert len(loaded) == 3
        for pid in postings:
            assert loaded[pid].to_dict() == postings[pid].to_dict()

    def test_round_trip_with_optional_fields(self, tmp_path: Path) -> None:
        p = Posting(
            id="abc",
            company="Acme",
            company_slug="acme",
            title="SWE Intern",
            location="NYC",
            locations=["NYC"],
            url="https://boards.greenhouse.io/acme/jobs/1",
            source="greenhouse",
            source_job_id="1",
            ats="greenhouse",
            posted_at="2026-09-01T00:00:00Z",
            first_seen_at="2026-09-01T00:00:00Z",
            last_seen_at="2026-09-01T00:00:00Z",
            closed_at="2026-09-10T00:00:00Z",
            compensation="$40/hr",
            merged_from=["other1"],
        )
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, {p.id: p}, TS)

        loaded = load_feed_sharded(feed_dir)
        lp = loaded["abc"]
        assert lp.closed_at == "2026-09-10T00:00:00Z"
        assert lp.compensation == "$40/hr"
        assert lp.merged_from == ["other1"]

    def test_round_trip_byte_stability(self, tmp_path: Path) -> None:
        postings = {
            "b": _make_posting(pid="b", source="lever"),
            "a": _make_posting(pid="a", source="greenhouse"),
        }
        feed_dir = tmp_path / "feed"

        save_feed_sharded(feed_dir, postings, TS)
        bytes1_gh = (feed_dir / "greenhouse.json").read_bytes()
        bytes1_lv = (feed_dir / "lever.json").read_bytes()

        loaded = load_feed_sharded(feed_dir)
        save_feed_sharded(feed_dir, loaded, TS)
        bytes2_gh = (feed_dir / "greenhouse.json").read_bytes()
        bytes2_lv = (feed_dir / "lever.json").read_bytes()

        assert bytes1_gh == bytes2_gh
        assert bytes1_lv == bytes2_lv

    def test_sharded_matches_flat(self, tmp_path: Path) -> None:
        """Sharded write then load produces identical postings to flat write then load."""
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
            "c": _make_posting(pid="c", source="workday"),
        }

        flat_path = tmp_path / "flat" / "feed.json"
        save_feed(flat_path, postings, TS)
        flat_loaded = load_feed(flat_path)

        shard_dir = tmp_path / "sharded"
        save_feed_sharded(shard_dir, postings, TS)
        shard_loaded = load_feed_sharded(shard_dir)

        assert set(flat_loaded.keys()) == set(shard_loaded.keys())
        for pid in flat_loaded:
            assert flat_loaded[pid].to_dict() == shard_loaded[pid].to_dict()


class TestLoadFeedSharded:
    def test_missing_index_returns_empty(self, tmp_path: Path) -> None:
        result = load_feed_sharded(tmp_path / "nonexistent")
        assert result == {}

    def test_empty_index_returns_empty(self, tmp_path: Path) -> None:
        feed_dir = tmp_path / "feed"
        feed_dir.mkdir()
        (feed_dir / "index.json").write_text("", encoding="utf-8")
        result = load_feed_sharded(feed_dir)
        assert result == {}

    def test_missing_shard_file_skipped(self, tmp_path: Path) -> None:
        feed_dir = tmp_path / "feed"
        feed_dir.mkdir()
        index = {
            "version": 1,
            "updated_at": TS,
            "total_count": 1,
            "shards": [{"id": "ghost", "count": 1, "sha256": "x", "updated_at": TS}],
        }
        (feed_dir / "index.json").write_text(
            json.dumps(index), encoding="utf-8"
        )
        result = load_feed_sharded(feed_dir)
        assert result == {}


class TestMetaWithShards:
    def test_meta_includes_shard_hashes(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
        }
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        feed_dir = tmp_path / "feed"

        save_feed(feed_path, postings, TS)
        shard_hashes = save_feed_sharded(feed_dir, postings, TS)
        save_meta(meta_path, feed_path, TS, len(postings), shard_hashes=shard_hashes)

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        assert meta["sharded"] is True
        assert "shards" in meta
        assert set(meta["shards"].keys()) == {"greenhouse", "lever"}
        for sid in meta["shards"]:
            assert meta["shards"][sid]["sha256"] == shard_hashes[sid].sha256
            assert meta["shards"][sid]["count"] == shard_hashes[sid].count

    def test_meta_without_shards_has_no_shard_key(self, tmp_path: Path) -> None:
        p = _make_posting()
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        save_feed(feed_path, {p.id: p}, TS)
        save_meta(meta_path, feed_path, TS, 1)

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        assert "sharded" not in meta
        assert "shards" not in meta

    def test_meta_sha256_still_matches_flat_feed(self, tmp_path: Path) -> None:
        postings = {"a": _make_posting(pid="a")}
        feed_path = tmp_path / "feed.json"
        meta_path = tmp_path / "meta.json"
        feed_dir = tmp_path / "feed"

        save_feed(feed_path, postings, TS)
        shard_hashes = save_feed_sharded(feed_dir, postings, TS)
        save_meta(meta_path, feed_path, TS, 1, shard_hashes=shard_hashes)

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        expected = hashlib.sha256(feed_path.read_bytes()).hexdigest()
        assert meta["sha256"] == expected


class TestShardingThreshold:
    def test_threshold_accounts_for_published_descriptions(self) -> None:
        assert SHARDING_THRESHOLD == 1000


class TestGlobalDedupeBeforeSharding:
    def test_no_cross_shard_duplicates(self, tmp_path: Path) -> None:
        """After global dedupe, each posting appears in exactly one shard."""
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
            "c": _make_posting(pid="c", source="greenhouse"),
        }
        feed_dir = tmp_path / "feed"
        save_feed_sharded(feed_dir, postings, TS)

        all_ids: list[str] = []
        for shard_file in feed_dir.glob("*.json"):
            if shard_file.name == "index.json":
                continue
            data = json.loads(shard_file.read_text(encoding="utf-8"))
            all_ids.extend(data["postings"].keys())

        assert len(all_ids) == len(set(all_ids))
        assert set(all_ids) == {"a", "b", "c"}

    def test_total_count_matches_sum(self, tmp_path: Path) -> None:
        postings = {
            "a": _make_posting(pid="a", source="greenhouse"),
            "b": _make_posting(pid="b", source="lever"),
            "c": _make_posting(pid="c", source="ashby"),
        }
        feed_dir = tmp_path / "feed"
        hashes = save_feed_sharded(feed_dir, postings, TS)

        total_from_shards = sum(sm.count for sm in hashes.values())
        assert total_from_shards == len(postings)

        index = json.loads((feed_dir / "index.json").read_text(encoding="utf-8"))
        assert index["total_count"] == total_from_shards


class TestCreateParentDirs:
    def test_creates_nested_feed_dir(self, tmp_path: Path) -> None:
        feed_dir = tmp_path / "deep" / "nested" / "feed"
        postings = {"a": _make_posting(pid="a")}
        save_feed_sharded(feed_dir, postings, TS)
        assert (feed_dir / "index.json").exists()
        assert (feed_dir / "greenhouse.json").exists()
