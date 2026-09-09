from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

from poller.store import RunState, load_feed, load_feed_sharded, load_state, save_feed, save_state
from poller.tests.test_description_enrich import make_posting
from poller.tools.stage_descriptions import stage


def test_stage_preserves_listing_identity_and_poll_history(tmp_path: Path) -> None:
    base, candidate, output = [tmp_path / name for name in ("base", "candidate", "output")]
    registry = tmp_path / "companies.yaml"
    registry.write_text("[]", encoding="utf-8")
    first = make_posting("first", ats="other", url="https://example.com/first")
    second = make_posting("second", ats="other", url="https://example.com/second")
    save_feed(base / "feed.json", {"first": first, "second": second}, "2026-09-01")
    save_state(
        base / "state.json", RunState(run_count=15, absent_ids={"second": "2026-09-07T00:00:00Z"})
    )
    save_feed(
        candidate / "feed.json",
        {
            "first": replace(
                first,
                description_text="Complete source ending.",
                description_status="available",
                description_version=5,
                last_seen_at="2099-01-01",
            ),
            "second": replace(second, title="Different role", description_text="Wrong text"),
        },
        "2026-09-08",
    )
    assert stage(base, [candidate], output, registry) == 1
    rows = load_feed(output / "feed.json")
    assert rows["first"].last_seen_at == first.last_seen_at
    assert rows["first"].description_text == "Complete source ending."
    assert not rows["second"].description_text
    assert load_state(output / "state.json").run_count == 15
    assert load_state(output / "state.json").absent_ids == {"second": "2026-09-07T00:00:00Z"}
    assert load_feed_sharded(output / "feed")["first"].description_text == "Complete source ending."
    assert not load_feed(base / "feed.json")["first"].description_text


def test_stage_preserves_failed_attempt_without_erasing_existing_text(tmp_path: Path) -> None:
    base, candidate, output = [tmp_path / name for name in ("base", "candidate", "output")]
    registry = tmp_path / "companies.yaml"
    registry.write_text("[]", encoding="utf-8")
    missing = make_posting("missing", ats="other", url="https://example.com/missing")
    existing = replace(missing, id="existing", description_text="Previously recovered text")
    save_feed(base / "feed.json", {p.id: p for p in (missing, existing)}, "2026-09-08")
    save_feed(
        candidate / "feed.json",
        {
            p.id: replace(p, description_text="", description_status="unavailable")
            for p in (missing, existing)
        },
        "2026-09-08",
    )
    attempt = {"status": "failed", "error": "robots_disallowed"}
    save_state(candidate / "state.json", RunState(description_attempts={"missing": attempt}))
    stage(base, [candidate], output, registry)
    rows = load_feed(output / "feed.json")
    assert rows["missing"].description_status == "unavailable"
    assert rows["existing"].description_text == "Previously recovered text"
    assert load_state(output / "state.json").description_attempts["missing"] == attempt
