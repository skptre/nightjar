from __future__ import annotations

import json
import time

import httpx
import pytest

from poller.exceptions import SourceFetchError
from poller.http import USER_AGENT
from poller.tests.conftest import (
    MockTransport,
    html_response,
    json_response,
    make_mock_client,
)


class TestRetryLogic:
    @pytest.mark.asyncio
    async def test_429_twice_then_200(self) -> None:
        transport = MockTransport(
            [
                json_response({"error": "rate limited"}, status=429),
                json_response({"error": "rate limited"}, status=429),
                json_response({"jobs": []}),
            ]
        )
        client = await make_mock_client(transport)
        result = await client.get_json("https://api.example.com/jobs")
        assert result == {"jobs": []}
        assert len(transport.requests) == 3
        await client.close()

    @pytest.mark.asyncio
    async def test_500_three_times_raises(self) -> None:
        transport = MockTransport(
            [
                json_response({"error": "server error"}, status=500),
                json_response({"error": "server error"}, status=500),
                json_response({"error": "server error"}, status=500),
            ]
        )
        client = await make_mock_client(transport)
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
        transport = MockTransport(
            [
                json_response(
                    {"error": "rate limited"},
                    status=429,
                    headers={"Retry-After": "0.1"},
                ),
                json_response({"ok": True}),
            ]
        )
        client = await make_mock_client(transport)
        result = await client.get_json("https://api.example.com/jobs")
        assert result == {"ok": True}
        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_4xx_no_retry(self) -> None:
        transport = MockTransport(
            [
                json_response({"error": "not found"}, status=404),
            ]
        )
        client = await make_mock_client(transport)
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
        transport = MockTransport(
            [
                json_response({"a": 1}),
                json_response({"b": 2}),
            ]
        )
        client = await make_mock_client(transport)

        start = time.monotonic()
        await client.get_json("https://api.example.com/first")
        await client.get_json("https://api.example.com/second")
        elapsed = time.monotonic() - start

        assert elapsed >= 1.0
        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_different_hosts_no_delay(self) -> None:
        transport_a = MockTransport([json_response({"a": 1})])
        transport_b = MockTransport([json_response({"b": 2})])

        client_a = await make_mock_client(transport_a)
        client_b = await make_mock_client(transport_b)

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
        transport = MockTransport([json_response({"ok": True})])
        client = await make_mock_client(transport)
        await client.get_json("https://api.example.com/test")

        assert len(transport.requests) == 1
        request = transport.requests[0]
        assert request.headers.get("user-agent") == USER_AGENT
        await client.close()


class TestContentTypeValidation:
    @pytest.mark.asyncio
    async def test_html_response_raises_source_fetch_error(self) -> None:
        transport = MockTransport([html_response("<html>Bad Gateway</html>")])
        client = await make_mock_client(transport)
        with pytest.raises(SourceFetchError, match="expected JSON but got content-type"):
            await client.get_json(
                "https://api.example.com/jobs",
                source="greenhouse",
                company_slug="test",
            )
        await client.close()

    @pytest.mark.asyncio
    async def test_json_content_type_accepted(self) -> None:
        transport = MockTransport([json_response({"jobs": []})])
        client = await make_mock_client(transport)
        result = await client.get_json("https://api.example.com/jobs")
        assert result == {"jobs": []}
        await client.close()

    @pytest.mark.asyncio
    async def test_javascript_content_type_accepted(self) -> None:
        body = json.dumps({"ok": True}).encode()
        resp = httpx.Response(
            status_code=200,
            headers={"content-type": "application/javascript"},
            content=body,
        )
        transport = MockTransport([resp])
        client = await make_mock_client(transport)
        result = await client.get_json("https://api.example.com/test")
        assert result == {"ok": True}
        await client.close()


class TestErrorContext:
    @pytest.mark.asyncio
    async def test_error_includes_source_and_slug(self) -> None:
        transport = MockTransport([json_response({}, status=404)])
        client = await make_mock_client(transport)
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
        transport = MockTransport([json_response({"ok": True})])
        client = await make_mock_client(transport)
        await client.get_json(
            "https://api.example.com/jobs",
            params={"content": "true", "limit": "100"},
        )
        request = transport.requests[0]
        assert b"content=true" in request.url.raw_path
        assert b"limit=100" in request.url.raw_path
        await client.close()


@pytest.mark.asyncio
async def test_custom_api_key_is_not_forwarded_on_redirect() -> None:
    transport = MockTransport(
        [
            json_response({}, status=302, headers={"Location": "https://other.example.com/search"}),
            json_response({"jobs": []}),
        ]
    )
    client = await make_mock_client(transport)
    try:
        with pytest.raises(SourceFetchError, match="authenticated request redirected"):
            await client.get_json(
                "https://data.usajobs.gov/api/search", headers={"Authorization-Key": "fixture-key"}
            )
        assert len(transport.requests) == 1
    finally:
        await client.close()
