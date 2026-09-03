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
    employment_type: str | None = None
    department: str | None = None
    workplace_type: str | None = None
    valid_through: str | None = None
    merged_from: list[str] = field(default_factory=list)
    source_metadata: dict[str, Any] | None = None

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
        if self.employment_type is not None:
            d["employment_type"] = self.employment_type
        if self.department is not None:
            d["department"] = self.department
        if self.workplace_type is not None:
            d["workplace_type"] = self.workplace_type
        if self.valid_through is not None:
            d["valid_through"] = self.valid_through
        if self.merged_from:
            d["merged_from"] = list(self.merged_from)
        if self.source_metadata is not None:
            d["source_metadata"] = dict(self.source_metadata)
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
            employment_type=d.get("employment_type"),
            department=d.get("department"),
            workplace_type=d.get("workplace_type"),
            valid_through=d.get("valid_through"),
            merged_from=list(d.get("merged_from", [])),
            source_metadata=d.get("source_metadata"),
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
    employment_type: str | None = None
    department: str | None = None
    requisition_id: str | None = None
    workplace_type: str | None = None
    updated_at: str | None = None
    valid_through: str | None = None
    education_requirements: str | None = None
    experience_requirements: str | None = None
    occupational_category: str | None = None


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
    seasonal_pattern: str | None = None


@dataclass
class HotWatchStats:
    watch_started_at: str
    watch_expires_at: str
    requested_interval_minutes: int
    effective_interval_minutes: int
    successful_polls: int = 0
    failures: int = 0
    consecutive_failures: int = 0
    changes_found: int = 0
    last_change_at: str | None = None
    request_count: int = 0
    healthy: bool = True


@dataclass
class SourceHealth:
    last_polled_at: str | None = None
    healthy: bool = True
    error: str | None = None
    bootstrapped: bool = False
    potentially_truncated: bool = False
    last_change_at: str | None = None
    change_frequency: float = 0.0
    consecutive_unchanged: int = 0
    estimated_poll_cost: float = 0.0
    activity_poll_count: int = 0
    last_raw_id_hash: str | None = None
