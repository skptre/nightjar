from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from pathlib import Path

from poller.store import load_feed_sharded, save_feed_sharded
from poller.tests.test_description_enrich import make_posting


def test_complete_documents_are_externalized_and_round_trip(tmp_path: Path) -> None:
    posting = make_posting(
        "abc123",
        ats="greenhouse",
        url="https://example.com/job/1",
        description="Responsibilities\n\n" + "Complete content. " * 1000,
    )
    save_feed_sharded(tmp_path, {posting.id: posting}, "2026-09-07T00:00:00Z")
    shard = json.loads((tmp_path / "simplify.json").read_text(encoding="utf-8"))
    row = shard["postings"][posting.id]
    assert "description_text" not in row
    # Older clients must not treat a retained old document as freshly verified
    # just because they don't understand external description references.
    assert row["description_status"] == "unavailable"
    ref = row["description_ref"]
    assert ref["sha256"] == hashlib.sha256(posting.description_text.encode()).hexdigest()
    assert (tmp_path / ref["pack"]).exists()
    assert load_feed_sharded(tmp_path)[posting.id].description_text == posting.description_text


def test_unchanged_documents_keep_pack_identity_when_feed_timestamp_changes(tmp_path: Path) -> None:
    posting = make_posting(
        "abc123", ats="other", url="https://example.com/job/1", description="Complete description."
    )
    save_feed_sharded(tmp_path, {posting.id: posting}, "2026-09-07T00:00:00Z")
    paths = {p.name: p.read_bytes() for p in (tmp_path / "details").glob("*.json")}
    save_feed_sharded(tmp_path, {posting.id: posting}, "2026-09-08T00:00:00Z")
    assert {p.name: p.read_bytes() for p in (tmp_path / "details").glob("*.json")} == paths
    save_feed_sharded(
        tmp_path,
        {posting.id: replace(posting, description_text="Updated text.")},
        "2026-09-09T00:00:00Z",
    )
    assert len(list((tmp_path / "details").glob("*.json"))) == 1
    assert load_feed_sharded(tmp_path)[posting.id].description_text == "Updated text."


def test_corrupt_document_pack_never_loads_as_valid_source_text(tmp_path: Path) -> None:
    posting = make_posting(
        "abc123", ats="other", url="https://example.com/job/1", description="Complete description."
    )
    save_feed_sharded(tmp_path, {posting.id: posting}, "2026-09-07T00:00:00Z")
    for path in (tmp_path / "details").glob("*.json"):
        path.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="hash"):
        load_feed_sharded(tmp_path)


def test_packs_are_bounded_and_legacy_files_are_cleaned_after_save(tmp_path: Path) -> None:
    details = tmp_path / "details"
    details.mkdir()
    legacy = details / ("ab-" + "0" * 64 + ".json")
    legacy.write_text("{}")
    unrelated = details / "README.txt"
    unrelated.write_text("Keep this")
    rows = {
        str(i): make_posting(
            str(i),
            ats="other",
            url="https://example.com/job/" + str(i),
            description="Description " + str(i),
        )
        for i in range(100)
    }
    save_feed_sharded(tmp_path, rows, "2026-09-09")
    assert not legacy.exists()
    assert unrelated.exists()
    assert len(list(details.glob("descriptions-*.json"))) <= 16
    assert len(list(details.glob("*.json"))) <= 16
    assert load_feed_sharded(tmp_path) == rows
