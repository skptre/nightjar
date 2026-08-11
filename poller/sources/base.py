from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from poller.http import RateLimitedClient
    from poller.models import Company, Posting, RawPosting, SourceConfig


class SourceAdapter(ABC):
    """Base class for all ATS source adapters.

    Contract:
    - fetch() returns list[RawPosting] on success. Empty list means the board
      has zero jobs — a valid state.
    - fetch() raises SourceFetchError on any network/API failure. Returning []
      to signal an error violates the contract.
    - normalize() converts a single RawPosting into a Posting.
    """

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
