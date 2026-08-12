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
GOLDEN_FEED = GOLDEN_DIR / "feed.json"

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
]


def _load_fixture_bytes(adapter: str, name: str) -> bytes:
    return (FIXTURE_DIR / adapter / f"{name}.json").read_bytes()


class _FixtureTransport(httpx.AsyncBaseTransport):
    """Routes HTTP requests to fixture files based on hostname."""

    def __init__(self) -> None:
        self._routes: dict[str, bytes] = {
            "boards-api.greenhouse.io": _load_fixture_bytes(
                "greenhouse", "normal_board"
            ),
            "api.lever.co": _load_fixture_bytes("lever", "normal_board"),
            "api.ashbyhq.com": _load_fixture_bytes(
                "ashby", "compensation_board"
            ),
        }

    async def handle_async_request(
        self, request: httpx.Request,
    ) -> httpx.Response:
        url = str(request.url)
        for pattern, body in self._routes.items():
            if pattern in url:
                return httpx.Response(
                    status_code=200,
                    headers={"content-type": "application/json"},
                    content=body,
                    stream=httpx.ByteStream(body),
                )
        msg = f"No fixture route for {url}"
        raise ValueError(msg)


def _write_golden_registry(path: Path) -> None:
    path.write_text(yaml.dump(GOLDEN_COMPANIES), encoding="utf-8")


async def _patched_get_client(self: RateLimitedClient) -> httpx.AsyncClient:
    if self._client is None or self._client.is_closed:
        self._client = httpx.AsyncClient(
            transport=_FixtureTransport(),
            timeout=httpx.Timeout(5.0),
            headers={"User-Agent": USER_AGENT},
        )
    return self._client


async def run_golden_pipeline(data_dir: Path, registry_path: Path) -> None:
    _write_golden_registry(registry_path)

    with (
        patch("poller.main.datetime") as mock_dt,
        patch.object(
            RateLimitedClient, "_get_client", _patched_get_client,
        ),
    ):
        mock_dt.now.return_value = GOLDEN_DT
        mock_dt.strftime = datetime.strftime

        await run_pipeline(
            dry_run=True,
            registry_path=registry_path,
            data_dir=data_dir,
        )


@pytest.mark.asyncio()
class TestGoldenFile:
    async def test_output_matches_golden_file(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"

        await run_golden_pipeline(data_dir, registry_path)

        generated = (data_dir / "feed.json").read_bytes()
        expected = GOLDEN_FEED.read_bytes()

        if generated != expected:
            gen_data = json.loads(generated)
            exp_data = json.loads(expected)

            gen_ids = set(gen_data.get("postings", {}).keys())
            exp_ids = set(exp_data.get("postings", {}).keys())

            added = gen_ids - exp_ids
            removed = exp_ids - gen_ids

            diff_msg = (
                f"Golden file mismatch.\n"
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
