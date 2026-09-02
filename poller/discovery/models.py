from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

VALID_DISCOVERY_SOURCES = {
    "common_crawl",
    "redirect",
    "directory",
    "simplify",
    "community",
}
VALID_VERIFICATION_STATUSES = {
    "pending",
    "verified",
    "dead",
    "review_required",
}


@dataclass
class BoardCandidate:
    ats_type: str
    board_token: str
    board_url: str
    discovery_source: str
    first_seen: str
    last_seen: str
    source_urls: list[str] = field(default_factory=list)
    discovery_sources: list[str] = field(default_factory=list)
    verification_status: str = "pending"
    last_verified: str | None = None
    job_count_at_verification: int | None = None
    response_status: int | None = None
    estimated_poll_cost: int | None = None
    review_required: bool = False
    company_name: str | None = None
    employer_domain: str | None = None
    identity_slug: str | None = None
    eu: bool = False

    def __post_init__(self) -> None:
        if self.discovery_source not in VALID_DISCOVERY_SOURCES:
            raise ValueError(
                f"invalid discovery source: {self.discovery_source!r}"
            )
        if self.verification_status not in VALID_VERIFICATION_STATUSES:
            raise ValueError(
                f"invalid verification status: {self.verification_status!r}"
            )
        if not self.discovery_sources:
            self.discovery_sources = [self.discovery_source]
        elif self.discovery_source not in self.discovery_sources:
            self.discovery_sources.append(self.discovery_source)
        self.discovery_sources = sorted(set(self.discovery_sources))
        self.source_urls = sorted(set(self.source_urls))

    @property
    def key(self) -> tuple[str, str]:
        return self.ats_type.casefold(), self.board_token.casefold()

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ats_type": self.ats_type,
            "board_token": self.board_token,
            "board_url": self.board_url,
            "discovery_source": self.discovery_source,
            "discovery_sources": list(self.discovery_sources),
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "source_urls": list(self.source_urls),
            "verification_status": self.verification_status,
            "review_required": self.review_required,
        }
        optional = {
            "last_verified": self.last_verified,
            "job_count_at_verification": self.job_count_at_verification,
            "response_status": self.response_status,
            "estimated_poll_cost": self.estimated_poll_cost,
            "company_name": self.company_name,
            "employer_domain": self.employer_domain,
            "identity_slug": self.identity_slug,
        }
        data.update({key: value for key, value in optional.items() if value is not None})
        if self.eu:
            data["eu"] = True
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BoardCandidate:
        return cls(
            ats_type=str(data["ats_type"]),
            board_token=str(data["board_token"]),
            board_url=str(data["board_url"]),
            discovery_source=str(data["discovery_source"]),
            discovery_sources=[str(value) for value in data.get("discovery_sources", [])],
            first_seen=str(data["first_seen"]),
            last_seen=str(data["last_seen"]),
            source_urls=[str(value) for value in data.get("source_urls", [])],
            verification_status=str(data.get("verification_status", "pending")),
            last_verified=_optional_str(data.get("last_verified")),
            job_count_at_verification=_optional_int(
                data.get("job_count_at_verification")
            ),
            response_status=_optional_int(data.get("response_status")),
            estimated_poll_cost=_optional_int(data.get("estimated_poll_cost")),
            review_required=bool(data.get("review_required", False)),
            company_name=_optional_str(data.get("company_name")),
            employer_domain=_optional_str(data.get("employer_domain")),
            identity_slug=_optional_str(data.get("identity_slug")),
            eu=bool(data.get("eu", False)),
        )


def _optional_str(value: object) -> str | None:
    return str(value) if value is not None else None


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"not a valid integer value: {value!r}")
    return int(value)
