"""Shared evidence checks for paginated public job listings."""
from __future__ import annotations

from dataclasses import dataclass, field

from poller.exceptions import SourceParseError


@dataclass
class PaginationGuard:
    source: str
    company_slug: str
    page_size: int | None = None
    max_pages: int = 500
    expected: int = 0
    seen: set[str] = field(default_factory=set)
    pages: int = 0

    def observe(self, ids: list[str], total: object = None, *, terminal: bool = False) -> bool:
        self.pages += 1
        if total is not None:
            if isinstance(total, bool) or not str(total).isdigit():
                self.fail("invalid pagination total")
            self.expected = max(self.expected, int(str(total)))
        if (any(not job_id for job_id in ids) or len(set(ids)) != len(ids)
                or (ids and set(ids).issubset(self.seen))):
            self.fail("duplicate or repeated jobs in pagination")
        self.seen.update(ids)
        if not ids or terminal:
            if len(self.seen) < self.expected:
                self.fail(f"incomplete pagination: {len(self.seen)} of {self.expected} jobs")
            return True
        if self.expected and len(self.seen) >= self.expected:
            return True
        if not self.expected and self.page_size and len(ids) < self.page_size:
            return True
        if self.pages >= self.max_pages:
            self.fail("pagination safety limit reached before completion")
        return False

    def fail(self, message: str) -> None:
        raise SourceParseError(self.source, self.company_slug, message)
