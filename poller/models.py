from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any


def compute_posting_id(source: str, company_slug: str, source_job_id: str) -> str:
    raw = f"{source}:{company_slug}:{source_job_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Posting:
    id: str
    company: str
    company_slug: str
    title: str
    location: str
    locations: list[str]
    url: str
    source: str
    source_job_id: str
    ats: str
    posted_at: str | None
    first_seen_at: str
    last_seen_at: str
    description_text: str = ""
    closed_at: str | None = None
    compensation: str | None = None
    merged_from: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "company": self.company,
            "company_slug": self.company_slug,
            "title": self.title,
            "location": self.location,
            "locations": list(self.locations),
            "url": self.url,
            "source": self.source,
            "source_job_id": self.source_job_id,
            "ats": self.ats,
            "posted_at": self.posted_at,
            "first_seen_at": self.first_seen_at,
            "last_seen_at": self.last_seen_at,
            "closed_at": self.closed_at,
        }
        if self.compensation is not None:
            d["compensation"] = self.compensation
        if self.merged_from:
            d["merged_from"] = list(self.merged_from)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Posting:
        return cls(
            id=d["id"],
            company=d["company"],
            company_slug=d["company_slug"],
            title=d["title"],
            location=d["location"],
            locations=list(d["locations"]),
            url=d["url"],
            source=d["source"],
            source_job_id=d["source_job_id"],
            ats=d["ats"],
            posted_at=d.get("posted_at"),
            first_seen_at=d["first_seen_at"],
            last_seen_at=d["last_seen_at"],
            description_text=d.get("description_text", ""),
            closed_at=d.get("closed_at"),
            compensation=d.get("compensation"),
            merged_from=list(d.get("merged_from", [])),
        )


@dataclass
class RawPosting:
    source: str
    company_slug: str
    source_job_id: str
    title: str
    location: str
    locations: list[str]
    url: str
    posted_at: str | None
    description: str
    raw_data: dict[str, Any] = field(default_factory=dict)
    compensation: str | None = None


@dataclass
class SourceConfig:
    type: str
    board_token: str
    eu: bool = False


@dataclass
class Company:
    slug: str
    name: str
    tags: list[str]
    sources: list[SourceConfig]
    typical_open: str | None = None
    high_priority: bool = False


@dataclass
class SourceHealth:
    last_polled_at: str | None = None
    healthy: bool = True
    error: str | None = None
    bootstrapped: bool = False
    potentially_truncated: bool = False
