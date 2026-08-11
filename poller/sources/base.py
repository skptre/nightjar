from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, Posting, RawPosting, SourceConfig


class SourceAdapter(ABC):

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
