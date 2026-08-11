from __future__ import annotations

import json
from typing import Any

import httpx

from poller.http import USER_AGENT, RateLimitedClient


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
