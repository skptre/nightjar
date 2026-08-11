from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from poller.exceptions import SourceFetchError
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


def _json_response(
    data: Any, status: int = 200, headers: dict[str, str] | None = None,
) -> httpx.Response:
    import json

    body = json.dumps(data).encode()
    hdrs = {"content-type": "application/json"}
    if headers:
        hdrs.update(headers)
    return httpx.Response(status_code=status, headers=hdrs, content=body)


def _html_response(body: str = "<html>Error</html>", status: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code=200,
        headers={"content-type": "text/html"},
        content=body.encode(),
    )


async def _make_client_with_transport(
    transport: MockTransport,
) -> RateLimitedClient:
    client = RateLimitedClient()
    client._client = httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(5.0),
        headers={"User-Agent": USER_AGENT},
    )
    return client


class TestRetryLogic:
    @pytest.mark.asyncio
    async def test_429_twice_then_200(self) -> None:
        transport = MockTransport([
            _json_response({"error": "rate limited"}, status=429),
            _json_response({"error": "rate limited"}, status=429),
            _json_response({"jobs": []}),
        ])
        client = await _make_client_with_transport(transport)
        result = await client.get_json("https://api.example.com/jobs")
        assert result == {"jobs": []}
        assert len(transport.requests) == 3
        await client.close()

    @pytest.mark.asyncio
    async def test_500_three_times_raises(self) -> None:
        transport = MockTransport([
            _json_response({"error": "server error"}, status=500),
            _json_response({"error": "server error"}, status=500),
            _json_response({"error": "server error"}, status=500),
        ])
        client = await _make_client_with_transport(transport)
        with pytest.raises(SourceFetchError, match="HTTP 500 after 3 attempts"):
            await client.get_json(
                "https://api.example.com/jobs",
                source="greenhouse",
                company_slug="test",
            )
        assert len(transport.requests) == 3
        await client.close()

    @pytest.mark.asyncio
    async def test_429_with_retry_after_header(self) -> None:
        transport = MockTransport([
            _json_response(
                {"error": "rate limited"},
                status=429,
                headers={"Retry-After": "0.1"},
            ),
            _json_response({"ok": True}),
        ])
        client = await _make_client_with_transport(transport)
        result = await client.get_json("https://api.example.com/jobs")
        assert result == {"ok": True}
        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_4xx_no_retry(self) -> None:
        transport = MockTransport([
            _json_response({"error": "not found"}, status=404),
        ])
        client = await _make_client_with_transport(transport)
        with pytest.raises(SourceFetchError, match="HTTP 404"):
            await client.get_json(
                "https://api.example.com/jobs",
                source="greenhouse",
                company_slug="test",
            )
        assert len(transport.requests) == 1
        await client.close()


class TestRateLimiting:
    @pytest.mark.asyncio
    async def test_same_host_has_delay(self) -> None:
        transport = MockTransport([
            _json_response({"a": 1}),
            _json_response({"b": 2}),
        ])
        client = await _make_client_with_transport(transport)

        start = time.monotonic()
        await client.get_json("https://api.example.com/first")
        await client.get_json("https://api.example.com/second")
        elapsed = time.monotonic() - start

        assert elapsed >= 1.0
        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_different_hosts_no_delay(self) -> None:
        transport_a = MockTransport([_json_response({"a": 1})])
        transport_b = MockTransport([_json_response({"b": 2})])

        client_a = await _make_client_with_transport(transport_a)
        client_b = await _make_client_with_transport(transport_b)

        start = time.monotonic()
        await client_a.get_json("https://api-a.example.com/first")
        await client_b.get_json("https://api-b.example.com/second")
        elapsed = time.monotonic() - start

        assert elapsed < 2.0
        await client_a.close()
        await client_b.close()


class TestUserAgent:
    @pytest.mark.asyncio
    async def test_user_agent_present(self) -> None:
        transport = MockTransport([_json_response({"ok": True})])
        client = await _make_client_with_transport(transport)
        await client.get_json("https://api.example.com/test")

        assert len(transport.requests) == 1
        request = transport.requests[0]
        assert request.headers.get("user-agent") == USER_AGENT
        await client.close()


class TestContentTypeValidation:
    @pytest.mark.asyncio
    async def test_html_response_raises_source_fetch_error(self) -> None:
        transport = MockTransport([_html_response("<html>Bad Gateway</html>")])
        client = await _make_client_with_transport(transport)
        with pytest.raises(SourceFetchError, match="expected JSON but got content-type"):
            await client.get_json(
                "https://api.example.com/jobs",
                source="greenhouse",
                company_slug="test",
            )
        await client.close()

    @pytest.mark.asyncio
    async def test_json_content_type_accepted(self) -> None:
        transport = MockTransport([_json_response({"jobs": []})])
        client = await _make_client_with_transport(transport)
        result = await client.get_json("https://api.example.com/jobs")
        assert result == {"jobs": []}
        await client.close()

    @pytest.mark.asyncio
    async def test_javascript_content_type_accepted(self) -> None:
        import json

        body = json.dumps({"ok": True}).encode()
        resp = httpx.Response(
            status_code=200,
            headers={"content-type": "application/javascript"},
            content=body,
        )
        transport = MockTransport([resp])
        client = await _make_client_with_transport(transport)
        result = await client.get_json("https://api.example.com/test")
        assert result == {"ok": True}
        await client.close()


class TestErrorContext:
    @pytest.mark.asyncio
    async def test_error_includes_source_and_slug(self) -> None:
        transport = MockTransport([_json_response({}, status=404)])
        client = await _make_client_with_transport(transport)
        with pytest.raises(SourceFetchError) as exc_info:
            await client.get_json(
                "https://api.example.com/jobs",
                source="lever",
                company_slug="testco",
            )
        assert exc_info.value.source == "lever"
        assert exc_info.value.company_slug == "testco"
        await client.close()

    @pytest.mark.asyncio
    async def test_params_passed_to_request(self) -> None:
        transport = MockTransport([_json_response({"ok": True})])
        client = await _make_client_with_transport(transport)
        await client.get_json(
            "https://api.example.com/jobs",
            params={"content": "true", "limit": "100"},
        )
        request = transport.requests[0]
        assert b"content=true" in request.url.raw_path
        assert b"limit=100" in request.url.raw_path
        await client.close()
