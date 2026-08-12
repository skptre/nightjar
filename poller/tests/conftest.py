from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from poller.http import USER_AGENT, RateLimitedClient
from poller.models import Company, Posting, SourceConfig, SourceHealth

FIXTURES_DIR = Path(__file__).parent / "fixtures"


class MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = list(responses)
        self._call_count = 0
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._call_count < len(self._responses):
            resp = self._responses[self._call_count]
        else:
            resp = self._responses[-1]
        self._call_count += 1
        resp.stream = httpx.ByteStream(resp.content)
        return resp


def json_response(
    data: Any, status: int = 200, headers: dict[str, str] | None = None,
) -> httpx.Response:
    body = json.dumps(data).encode()
    hdrs = {"content-type": "application/json"}
    if headers:
        hdrs.update(headers)
    return httpx.Response(status_code=status, headers=hdrs, content=body)


def html_response(body: str = "<html>Error</html>", status: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        headers={"content-type": "text/html"},
        content=body.encode(),
    )


async def make_mock_client(transport: MockTransport) -> RateLimitedClient:
    client = RateLimitedClient()
    client._client = httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(5.0),
        headers={"User-Agent": USER_AGENT},
    )
    return client


def load_fixture(adapter: str, name: str) -> Any:
    path = FIXTURES_DIR / adapter / f"{name}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def make_company(
    slug: str = "acme",
    name: str = "Acme Corp",
    source_type: str = "greenhouse",
    board_token: str = "acme",
    tags: list[str] | None = None,
    high_priority: bool = False,
    typical_open: str | None = None,
    eu: bool = False,
) -> Company:
    return Company(
        slug=slug,
        name=name,
        tags=tags or ["tech"],
        sources=[SourceConfig(type=source_type, board_token=board_token, eu=eu)],
        typical_open=typical_open,
        high_priority=high_priority,
    )


def make_posting(
    pid: str = "abc123",
    company: str = "Acme Corp",
    company_slug: str = "acme",
    title: str = "SWE Intern",
    source: str = "greenhouse",
    source_job_id: str = "100",
    first_seen: str = "2026-09-01T00:00:00Z",
    last_seen: str = "2026-09-01T00:00:00Z",
    closed_at: str | None = None,
    location: str = "New York, NY",
    locations: list[str] | None = None,
    compensation: str | None = None,
) -> Posting:
    return Posting(
        id=pid,
        company=company,
        company_slug=company_slug,
        title=title,
        location=location,
        locations=locations or [location],
        url=f"https://boards.greenhouse.io/{company_slug}/jobs/{source_job_id}",
        source=source,
        source_job_id=source_job_id,
        ats=source,
        posted_at="2026-09-01T00:00:00Z",
        first_seen_at=first_seen,
        last_seen_at=last_seen,
        closed_at=closed_at,
        compensation=compensation,
    )


def make_source_health(
    last_polled_at: str | None = "2026-09-01T00:00:00Z",
    healthy: bool = True,
    bootstrapped: bool = True,
    error: str | None = None,
    potentially_truncated: bool = False,
) -> SourceHealth:
    return SourceHealth(
        last_polled_at=last_polled_at,
        healthy=healthy,
        bootstrapped=bootstrapped,
        error=error,
        potentially_truncated=potentially_truncated,
    )


@pytest.fixture()
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    return d
