from __future__ import annotations

from typing import TYPE_CHECKING

from poller.sources.base import SourceAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, Posting, RawPosting, SourceConfig


class SmartRecruitersAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        raise NotImplementedError("SmartRecruitersAdapter.fetch not yet implemented")

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        raise NotImplementedError("SmartRecruitersAdapter.normalize not yet implemented")
