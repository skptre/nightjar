from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import yaml

from poller.http import USER_AGENT, RateLimitedClient
from poller.main import run_pipeline

FIXTURE_DIR = Path(__file__).parent / "fixtures"
GOLDEN_DIR = Path(__file__).parent / "golden"
GOLDEN_FEED_P25 = GOLDEN_DIR / "feed_phase25.json"

GOLDEN_TIME = "2026-09-15T12:00:00Z"
GOLDEN_DT = datetime(2026, 9, 15, 12, 0, 0, tzinfo=UTC)

GOLDEN_COMPANIES: list[dict[str, Any]] = [
    {
        "slug": "watershed",
        "name": "Watershed Bio",
        "tags": ["biotech"],
        "sources": [{"type": "greenhouse", "board_token": "watershed"}],
    },
    {
        "slug": "palantir",
        "name": "Palantir",
        "tags": ["defense", "data"],
        "sources": [{"type": "lever", "board_token": "palantir"}],
    },
    {
        "slug": "testco",
        "name": "TestCo",
        "tags": ["tech"],
        "sources": [{"type": "ashby", "board_token": "testco"}],
    },
    {
        "slug": "nvidia-wd",
        "name": "NVIDIA",
        "tags": ["hardware", "ai"],
        "sources": [
            {
                "type": "workday",
                "board_token": "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
            },
        ],
    },
    {
        "slug": "testcorp-sr",
        "name": "TestCorp SR",
        "tags": ["tech"],
        "sources": [{"type": "smartrecruiters", "board_token": "TestCorp"}],
    },
]


def _load_fixture_bytes(adapter: str, name: str) -> bytes:
    return (FIXTURE_DIR / adapter / f"{name}.json").read_bytes()


class _Phase25FixtureTransport(httpx.AsyncBaseTransport):
    """Routes HTTP requests to fixture files for all 6 source types."""

    def __init__(self) -> None:
        self._greenhouse = _load_fixture_bytes("greenhouse", "normal_board")
        self._lever = _load_fixture_bytes("lever", "normal_board")
        self._ashby = _load_fixture_bytes("ashby", "compensation_board")
        self._workday = _load_fixture_bytes("workday", "single_page")
        self._smartrecruiters_list = _load_fixture_bytes(
            "smartrecruiters", "single_page",
        )
        self._simplify = _load_fixture_bytes(
            "simplify", "active_visible_listings",
        )

    async def handle_async_request(
        self, request: httpx.Request,
    ) -> httpx.Response:
        url = str(request.url)
        method = request.method

        if "boards-api.greenhouse.io" in url:
            return self._json_response(self._greenhouse)

        if "api.lever.co" in url:
            return self._json_response(self._lever)

        if "api.ashbyhq.com" in url:
            return self._json_response(self._ashby)

        if "myworkdayjobs.com" in url and method == "POST":
            return self._json_response(self._workday)

        if "api.smartrecruiters.com" in url:
            return self._json_response(self._smartrecruiters_list)

        if "raw.githubusercontent.com" in url and "listings.json" in url:
            return self._text_response(self._simplify)

        msg = f"No fixture route for {method} {url}"
        raise ValueError(msg)

    def _json_response(self, body: bytes) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=body,
            stream=httpx.ByteStream(body),
        )

    def _text_response(self, body: bytes) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            headers={"content-type": "text/plain; charset=utf-8"},
            content=body,
            stream=httpx.ByteStream(body),
        )


def _write_golden_registry(path: Path) -> None:
    path.write_text(yaml.dump(GOLDEN_COMPANIES), encoding="utf-8")


async def _patched_get_client(self: RateLimitedClient) -> httpx.AsyncClient:
    if self._client is None or self._client.is_closed:
        self._client = httpx.AsyncClient(
            transport=_Phase25FixtureTransport(),
            timeout=httpx.Timeout(5.0),
            headers={"User-Agent": USER_AGENT},
        )
    return self._client


async def run_golden_pipeline_phase25(
    data_dir: Path, registry_path: Path,
) -> None:
    _write_golden_registry(registry_path)

    with (
        patch("poller.main.datetime") as mock_dt,
        patch.object(
            RateLimitedClient, "_get_client", _patched_get_client,
        ),
        patch("poller.sources.workday.asyncio.sleep", return_value=None),
    ):
        mock_dt.now.return_value = GOLDEN_DT
        mock_dt.strftime = datetime.strftime

        await run_pipeline(
            dry_run=True,
            registry_path=registry_path,
            data_dir=data_dir,
            skip_simplify=False,
            skip_registry_candidates=True,
        )


@pytest.mark.asyncio()
class TestGoldenFilePhase25:
    async def test_output_matches_golden_file(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        await run_golden_pipeline_phase25(data_dir, registry_path)

        generated = (data_dir / "feed.json").read_bytes()
        expected = GOLDEN_FEED_P25.read_bytes()

        if generated != expected:
            gen_data = json.loads(generated)
            exp_data = json.loads(expected)

            gen_ids = set(gen_data.get("postings", {}).keys())
            exp_ids = set(exp_data.get("postings", {}).keys())

            added = gen_ids - exp_ids
            removed = exp_ids - gen_ids

            diff_msg = (
                f"Phase 2.5 golden file mismatch.\n"
                f"Generated {len(gen_ids)} postings, expected {len(exp_ids)}.\n"
            )
            if added:
                diff_msg += f"New IDs: {added}\n"
            if removed:
                diff_msg += f"Missing IDs: {removed}\n"

            for pid in gen_ids & exp_ids:
                gp = gen_data["postings"][pid]
                ep = exp_data["postings"][pid]
                if gp != ep:
                    for key in set(gp) | set(ep):
                        if gp.get(key) != ep.get(key):
                            diff_msg += (
                                f"  {pid}.{key}: "
                                f"{gp.get(key)!r} != {ep.get(key)!r}\n"
                            )

            pytest.fail(diff_msg)

    async def test_includes_all_source_types(self, tmp_path: Path) -> None:
        """Verify golden output contains postings from all 6 source types."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        await run_golden_pipeline_phase25(data_dir, registry_path)

        feed = json.loads((data_dir / "feed.json").read_text(encoding="utf-8"))
        sources = {p["source"] for p in feed["postings"].values()}

        assert "greenhouse" in sources
        assert "lever" in sources
        assert "ashby" in sources
        assert "workday" in sources
        assert "smartrecruiters" in sources
        assert "simplify" in sources

    async def test_idempotent_output(self, tmp_path: Path) -> None:
        """Two runs with same input produce identical bytes."""
        run1_dir = tmp_path / "run1"
        run1_dir.mkdir()
        run2_dir = tmp_path / "run2"
        run2_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        await run_golden_pipeline_phase25(run1_dir, registry_path)
        await run_golden_pipeline_phase25(run2_dir, registry_path)

        feed1 = (run1_dir / "feed.json").read_bytes()
        feed2 = (run2_dir / "feed.json").read_bytes()
        assert feed1 == feed2, "Two runs with identical input must produce identical bytes"
