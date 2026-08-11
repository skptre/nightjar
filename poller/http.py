from __future__ import annotations

import asyncio
import random
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from poller.exceptions import SourceFetchError

USER_AGENT = "nightjar/0.1 (+https://github.com/svhar/nightjar)"

DEFAULT_CONNECT_TIMEOUT = 30.0
DEFAULT_READ_TIMEOUT = 60.0
MAX_RETRIES = 3
BASE_DELAY = 1.0
MIN_HOST_DELAY = 1.0
MAX_JITTER = 0.5


class RateLimitedClient:
    def __init__(
        self,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
    ) -> None:
        self._client: httpx.AsyncClient | None = None
        self._connect_timeout = connect_timeout
        self._read_timeout = read_timeout
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._host_last_request: dict[str, float] = {}

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers={"User-Agent": USER_AGENT},
                timeout=httpx.Timeout(
                    connect=self._connect_timeout,
                    read=self._read_timeout,
                    write=self._read_timeout,
                    pool=self._read_timeout,
                ),
                follow_redirects=True,
            )
        return self._client

    def _get_host_lock(self, host: str) -> asyncio.Lock:
        if host not in self._host_locks:
            self._host_locks[host] = asyncio.Lock()
        return self._host_locks[host]

    async def _enforce_host_delay(self, host: str) -> None:
        last = self._host_last_request.get(host, 0.0)
        elapsed = time.monotonic() - last
        min_delay = MIN_HOST_DELAY + random.uniform(0, MAX_JITTER)
        if elapsed < min_delay:
            await asyncio.sleep(min_delay - elapsed)
        self._host_last_request[host] = time.monotonic()

    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> Any:
        host = urlparse(url).hostname or ""
        lock = self._get_host_lock(host)

        last_status: int = 0
        last_body: str = ""

        for attempt in range(MAX_RETRIES):
            async with lock:
                await self._enforce_host_delay(host)

                client = await self._get_client()
                try:
                    response = await client.get(url, params=params)
                except httpx.HTTPError as exc:
                    last_body = str(exc)
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(BASE_DELAY * (2**attempt))
                        continue
                    raise SourceFetchError(
                        source, company_slug, f"network error: {exc}"
                    ) from exc

                last_status = response.status_code
                last_body = response.text[:500]

                if response.status_code == 429 or response.status_code >= 500:
                    if attempt < MAX_RETRIES - 1:
                        if response.status_code == 429:
                            retry_after = response.headers.get("Retry-After")
                            if retry_after is not None:
                                try:
                                    delay = float(retry_after)
                                except ValueError:
                                    delay = BASE_DELAY * (2**attempt)
                            else:
                                delay = BASE_DELAY * (2**attempt)
                        else:
                            delay = BASE_DELAY * (2**attempt)
                        await asyncio.sleep(delay)
                        continue

                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"HTTP {response.status_code} after {MAX_RETRIES} attempts: "
                        f"{last_body[:200]}",
                    )

                if response.status_code >= 400:
                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"HTTP {response.status_code}: {last_body[:200]}",
                    )

                content_type = response.headers.get("content-type", "")
                if "json" not in content_type and "javascript" not in content_type:
                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"expected JSON but got content-type '{content_type}': "
                        f"{last_body[:200]}",
                    )

                return response.json()

        raise SourceFetchError(
            source,
            company_slug,
            f"exhausted {MAX_RETRIES} retries (last status={last_status}): "
            f"{last_body[:200]}",
        )

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> RateLimitedClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
