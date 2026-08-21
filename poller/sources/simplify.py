from __future__ import annotations

from typing import TYPE_CHECKING

from poller.sources.base import SourceAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, Posting, RawPosting, SourceConfig


class SimplifyAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        raise NotImplementedError("SimplifyAdapter.fetch not yet implemented")

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        raise NotImplementedError("SimplifyAdapter.normalize not yet implemented")
