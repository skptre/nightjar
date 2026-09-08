from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING, Any

from poller.store import save_feed
from poller.tests.test_description_enrich import FakeClient, make_posting
from poller.tools import enrich_descriptions

if TYPE_CHECKING:
    from pathlib import Path

    import pytest


class ToolClient(FakeClient):
    async def __aenter__(self) -> ToolClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass

    def load_cache(self, cache: Any) -> None:
        pass

    def dump_cache(self) -> dict[str, dict[str, str]]:
        return {}


def test_isolated_tool_resolves_registry_board_reports_and_resumes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    feed = tmp_path / "input.json"
    registry = tmp_path / "companies.yaml"
    output = tmp_path / "backfill"
    posting = make_posting("1", ats="other", url="https://example.com/jobs?gh_jid=123")
    save_feed(feed, {posting.id: posting}, "2026-09-07T00:00:00Z")
    original = feed.read_bytes()
    registry.write_text(
        '- slug: example\n  name: Example\n  tags: [tech]\n  sources:\n'
        '    - type: greenhouse\n      board_token: actual-board\n', encoding="utf-8",
    )
    client = ToolClient({
        "https://boards-api.greenhouse.io/v1/boards/actual-board/jobs/123": {
            "content": "<p>Develop software.</p>",
        },
    })
    monkeypatch.setattr(enrich_descriptions, "RateLimitedClient", lambda: client)
    monkeypatch.setattr(sys, "argv", ["enrich_descriptions", "--live", "--feed", str(feed),
                                    "--registry", str(registry), "--output", str(output)])
    enrich_descriptions.main()
    report = json.loads((output / "report.json").read_text())
    assert report["resolvable_ats"] == 1
    assert report["attempted_this_run"] == report["fetched_this_run"] == 1
    assert report["acquisition_by_provider"] == {"greenhouse": {"available": 1}}
    assert report["feed_bytes"] > 0 and report["shard_bytes"]
    enrich_descriptions.main()
    report = json.loads((output / "report.json").read_text())
    assert len(client.calls) == 1
    assert report["fetched_this_run"] == 0 and report["with_description_after"] == 1
    assert feed.read_bytes() == original


def test_multiple_bounded_rounds_advance_and_report_complete_denominator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    feed = tmp_path / "input.json"
    registry = tmp_path / "companies.yaml"
    output = tmp_path / "backfill"
    registry.write_text('[]', encoding="utf-8")
    postings = {str(i): make_posting(str(i), ats="greenhouse",
                url=f"https://job-boards.greenhouse.io/acme/jobs/{i}") for i in (123, 456)}
    save_feed(feed, postings, "2026-09-07T00:00:00Z")
    client = ToolClient({f"https://boards-api.greenhouse.io/v1/boards/acme/jobs/{i}":
                         {"id": i, "content": "Complete job description."} for i in (123, 456)})
    monkeypatch.setattr(enrich_descriptions, "RateLimitedClient", lambda: client)
    monkeypatch.setattr(sys, "argv", ["enrich_descriptions", "--live", "--feed", str(feed),
        "--registry", str(registry), "--output", str(output), "--limit", "1", "--rounds", "3"])
    enrich_descriptions.main()
    report = json.loads((output / "report.json").read_text())
    assert report["fetched_this_run"] == report["complete_available"] == 2
    assert report["complete_percent"] == 100.0
    assert report["detail_pack_bytes"] > 0
    assert len(client.calls) == 2
