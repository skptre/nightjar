from __future__ import annotations

import asyncio
import ipaddress
import random
import re
import time
from contextlib import suppress
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from poller.exceptions import SourceFetchError

USER_AGENT = "nightjar/0.1 (+https://github.com/svhar/nightjar)"

DEFAULT_CONNECT_TIMEOUT = 30.0
DEFAULT_READ_TIMEOUT = 60.0
MAX_RETRIES = 3
BASE_DELAY = 1.0
MIN_HOST_DELAY = 1.0
MAX_JITTER = 0.5

_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.IGNORECASE)
_NON_PUBLIC_SUFFIXES = (".local", ".internal", ".localhost", ".home", ".arpa")


DEFAULT_HOST_BUDGET = 500

NOT_MODIFIED = object()


def is_public_hostname(hostname: str) -> bool:
    """Reject local/private URL targets before discovery makes a request."""
    host = hostname.casefold().rstrip(".").strip("[]")
    if not host or host == "localhost" or host.endswith(_NON_PUBLIC_SUFFIXES):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        labels = host.split(".")
        return len(labels) >= 2 and all(_DNS_LABEL_RE.fullmatch(label) for label in labels)
    return address.is_global


class RateLimitedClient:
    def __init__(
        self,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
        host_budget: int = DEFAULT_HOST_BUDGET,
    ) -> None:
        self._client: httpx.AsyncClient | None = None
        self._connect_timeout = connect_timeout
        self._read_timeout = read_timeout
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._host_last_request: dict[str, float] = {}
        self._http_cache: dict[str, dict[str, str]] = {}
        self._host_request_counts: dict[str, int] = {}
        self._source_request_counts: dict[str, int] = {}
        self._host_budget = host_budget

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

    def _check_host_budget(self, host: str) -> bool:
        count = self._host_request_counts.get(host, 0)
        return count < self._host_budget

    def _record_request(
        self, host: str, source: str = "", company_slug: str = "",
    ) -> None:
        self._host_request_counts[host] = self._host_request_counts.get(host, 0) + 1
        if source and company_slug:
            key = f"{source}:{company_slug}"
            self._source_request_counts[key] = self._source_request_counts.get(key, 0) + 1

    def source_request_counts(self) -> dict[str, int]:
        return dict(self._source_request_counts)

    def _get_conditional_headers(self, url: str) -> dict[str, str]:
        headers: dict[str, str] = {}
        entry = self._http_cache.get(url)
        if entry:
            if "etag" in entry:
                headers["If-None-Match"] = entry["etag"]
            if "last_modified" in entry:
                headers["If-Modified-Since"] = entry["last_modified"]
        return headers

    def _update_cache(self, url: str, response: httpx.Response) -> None:
        etag = response.headers.get("ETag")
        last_mod = response.headers.get("Last-Modified")
        if etag or last_mod:
            entry: dict[str, str] = {}
            if etag:
                entry["etag"] = etag
            if last_mod:
                entry["last_modified"] = last_mod
            self._http_cache[url] = entry

    def load_cache(self, cache_data: dict[str, dict[str, str]]) -> None:
        self._http_cache = dict(cache_data)

    def dump_cache(self) -> dict[str, dict[str, str]]:
        return dict(self._http_cache)

    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        allow_plain_text: bool = False,
        use_conditional: bool = False,
    ) -> Any:
        host = urlparse(url).hostname or ""
        lock = self._get_host_lock(host)

        if not self._check_host_budget(host):
            raise SourceFetchError(
                source, company_slug,
                f"host budget exceeded for {host} ({self._host_budget} requests)",
            )

        last_status: int = 0
        last_body: str = ""

        cond_headers = self._get_conditional_headers(url)

        for attempt in range(MAX_RETRIES):
            async with lock:
                await self._enforce_host_delay(host)
                self._record_request(host, source, company_slug)

                client = await self._get_client()
                try:
                    response = await client.get(
                        url, params=params, headers=cond_headers,
                    )
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

                if response.status_code == 304:
                    if use_conditional:
                        return NOT_MODIFIED
                    cond_headers = {}
                    if attempt < MAX_RETRIES - 1:
                        continue
                    raise SourceFetchError(
                        source, company_slug,
                        "server returned 304 without conditional request",
                    )

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

                self._update_cache(url, response)

                content_type = response.headers.get("content-type", "")
                json_like = "json" in content_type or "javascript" in content_type
                plain_ok = allow_plain_text and "text/plain" in content_type
                if not json_like and not plain_ok:
                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"expected JSON but got content-type '{content_type}': "
                        f"{last_body[:200]}",
                    )

                return response.json()

        raise SourceFetchError(  # pragma: no cover — loop always returns or raises
            source,
            company_slug,
            f"exhausted {MAX_RETRIES} retries (last status={last_status}): "
            f"{last_body[:200]}",
        )

    async def get_text(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        follow_redirects: bool = True,
    ) -> str:
        """Fetch public text/NDJSON with the standard retry and rate-limit policy."""
        host = urlparse(url).hostname or ""
        lock = self._get_host_lock(host)
        last_status = 0
        last_body = ""

        for attempt in range(MAX_RETRIES):
            if not self._check_host_budget(host):
                raise SourceFetchError(
                    source,
                    company_slug,
                    f"host budget exceeded for {host} ({self._host_budget} requests)",
                )
            async with lock:
                await self._enforce_host_delay(host)
                self._record_request(host, source, company_slug)
                client = await self._get_client()
                try:
                    response = await client.get(
                        url,
                        params=params,
                        headers={"User-Agent": USER_AGENT},
                        follow_redirects=follow_redirects,
                    )
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
                if not follow_redirects and 300 <= response.status_code < 400:
                    location = response.headers.get("Location")
                    if not location:
                        raise SourceFetchError(
                            source,
                            company_slug,
                            f"HTTP {response.status_code} redirect lacked Location",
                        )
                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"redirect {response.status_code}: {urljoin(url, location)}",
                    )
                if response.status_code == 429 or response.status_code >= 500:
                    if attempt < MAX_RETRIES - 1:
                        delay = BASE_DELAY * (2**attempt)
                        if response.status_code == 429:
                            retry_after = response.headers.get("Retry-After")
                            if retry_after is not None:
                                with suppress(ValueError):
                                    delay = float(retry_after)
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
                content_type = response.headers.get("content-type", "").casefold()
                textual = (
                    not content_type
                    or "text/" in content_type
                    or "json" in content_type
                    or "javascript" in content_type
                    or "xml" in content_type
                )
                if not textual:
                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"expected text but got content-type '{content_type}'",
                    )
                return response.text

        raise SourceFetchError(  # pragma: no cover — loop always returns or raises
            source,
            company_slug,
            f"exhausted {MAX_RETRIES} retries (last status={last_status}): "
            f"{last_body[:200]}",
        )

    async def resolve_url(
        self,
        url: str,
        *,
        source: str = "",
        company_slug: str = "",
        max_redirects: int = 3,
    ) -> tuple[str, int]:
        """Resolve a public URL with an explicit, bounded redirect chain."""
        if max_redirects < 0 or max_redirects > 3:
            raise ValueError("max_redirects must be between 0 and 3")
        current = url
        redirect_count = 0

        while True:
            parsed = urlparse(current)
            if (
                parsed.scheme not in {"http", "https"}
                or parsed.username
                or parsed.password
                or not parsed.hostname
                or not is_public_hostname(parsed.hostname)
            ):
                raise SourceFetchError(source, company_slug, "unsafe redirect URL")
            host = parsed.hostname
            lock = self._get_host_lock(host)
            response: httpx.Response | None = None

            for attempt in range(MAX_RETRIES):
                if not self._check_host_budget(host):
                    raise SourceFetchError(
                        source,
                        company_slug,
                        f"host budget exceeded for {host} ({self._host_budget} requests)",
                    )
                async with lock:
                    await self._enforce_host_delay(host)
                    self._record_request(host, source, company_slug)
                    client = await self._get_client()
                    try:
                        response = await client.get(
                            current,
                            follow_redirects=False,
                            headers={"User-Agent": USER_AGENT},
                        )
                    except httpx.HTTPError as exc:
                        if attempt < MAX_RETRIES - 1:
                            await asyncio.sleep(BASE_DELAY * (2**attempt))
                            continue
                        raise SourceFetchError(
                            source, company_slug, f"network error: {exc}"
                        ) from exc
                    if response.status_code == 429 or response.status_code >= 500:
                        if attempt < MAX_RETRIES - 1:
                            await asyncio.sleep(BASE_DELAY * (2**attempt))
                            continue
                        raise SourceFetchError(
                            source,
                            company_slug,
                            f"HTTP {response.status_code} after {MAX_RETRIES} attempts",
                        )
                    break

            if response is None:  # pragma: no cover — retry loop returns or raises
                raise SourceFetchError(source, company_slug, "no redirect response")
            if response.status_code >= 400:
                raise SourceFetchError(
                    source, company_slug, f"HTTP {response.status_code}"
                )
            if response.status_code not in {301, 302, 303, 307, 308}:
                return str(response.url), response.status_code
            location = response.headers.get("Location")
            if not location:
                raise SourceFetchError(
                    source, company_slug, "redirect response lacked Location"
                )
            if redirect_count >= max_redirects:
                raise SourceFetchError(
                    source,
                    company_slug,
                    f"redirect limit exceeded ({max_redirects})",
                )
            current = urljoin(current, location)
            redirect_count += 1

    async def post_json(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        source: str = "",
        company_slug: str = "",
    ) -> Any:
        host = urlparse(url).hostname or ""
        lock = self._get_host_lock(host)

        if not self._check_host_budget(host):
            raise SourceFetchError(
                source, company_slug,
                f"host budget exceeded for {host} ({self._host_budget} requests)",
            )

        last_status: int = 0
        last_body: str = ""

        for attempt in range(MAX_RETRIES):
            async with lock:
                await self._enforce_host_delay(host)
                self._record_request(host, source, company_slug)

                client = await self._get_client()
                try:
                    response = await client.post(url, json=json_body)
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
