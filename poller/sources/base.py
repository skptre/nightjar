from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from poller.exceptions import SourceParseError

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, Posting, RawPosting, SourceConfig


class SourceAdapter(ABC):
    # Any skipped record, exhausted crawl, or incomplete page must block absence
    # based closures, even when the remaining new records are usable.
    potentially_truncated: bool = False

    def listing_items(
        self, data: dict[str, Any], key: str, source: str, company_slug: str,
    ) -> list[Any]:
        items = data.get(key)
        if not isinstance(items, list):
            raise SourceParseError(source, company_slug, f"expected '{key}' array")
        # These endpoints are expected to return a whole board. New pagination
        # metadata or a larger declared count means that assumption no longer holds.
        containers = [data]
        for container in ("meta", "pagination", "links"):
            value = data.get(container)
            if isinstance(value, dict):
                containers.append(value)
                nested = value.get("pagination")
                if isinstance(nested, dict):
                    containers.append(nested)
        for value in containers:
            next_keys = ("next", "next_page", "nextPage", "hasNextPage", "has_more")
            if any(value.get(k) for k in next_keys):
                self.potentially_truncated = True
            for count_key in ("total", "totalCount", "total_count", "totalFound"):
                count = value.get(count_key)
                if count is not None:
                    if isinstance(count, bool) or not str(count).isdigit():
                        raise SourceParseError(source, company_slug, "invalid listing count")
                    if int(str(count)) > len(items):
                        self.potentially_truncated = True
        return items

    @abstractmethod
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        ...

    @abstractmethod
    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        ...
