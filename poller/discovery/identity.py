from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from rapidfuzz import fuzz

if TYPE_CHECKING:
    from pathlib import Path

    from poller.discovery.models import BoardCandidate

IDENTITY_SCHEMA_VERSION = 1
FUZZY_REVIEW_THRESHOLD = 90.0
_HOSTED_ATS_DOMAINS = {
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.eu.lever.co",
    "jobs.ashbyhq.com",
    "jobs.smartrecruiters.com",
}


@dataclass
class CompanyIdentity:
    slug: str
    canonical_name: str
    aliases: list[str] = field(default_factory=list)
    domains: list[str] = field(default_factory=list)
    ats_instances: list[dict[str, str]] = field(default_factory=list)
    parent_company: str | None = None
    subsidiaries: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "slug": self.slug,
            "canonical_name": self.canonical_name,
            "aliases": sorted(set(self.aliases)),
            "domains": sorted(set(self.domains)),
            "ats_instances": sorted(
                self.ats_instances,
                key=lambda item: (
                    item.get("ats_type", "").casefold(),
                    item.get("board_token", "").casefold(),
                ),
            ),
            "subsidiaries": sorted(set(self.subsidiaries)),
        }
        if self.parent_company:
            data["parent_company"] = self.parent_company
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CompanyIdentity:
        raw_instances = data.get("ats_instances", [])
        return cls(
            slug=str(data["slug"]),
            canonical_name=str(data["canonical_name"]),
            aliases=[str(value) for value in data.get("aliases", [])],
            domains=[str(value) for value in data.get("domains", [])],
            ats_instances=[
                {
                    "ats_type": str(item["ats_type"]),
                    "board_token": str(item["board_token"]),
                }
                for item in raw_instances
                if isinstance(item, dict)
                and "ats_type" in item
                and "board_token" in item
            ],
            parent_company=(
                str(data["parent_company"])
                if data.get("parent_company") is not None
                else None
            ),
            subsidiaries=[str(value) for value in data.get("subsidiaries", [])],
        )


@dataclass(frozen=True)
class IdentityResolution:
    status: str
    identity_slug: str | None
    reason: str
    score: float | None = None


def _normalize_domain(value: str | None) -> str | None:
    if not value:
        return None
    candidate = value if "://" in value else f"https://{value}"
    host = (urlparse(candidate).hostname or "").casefold().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if (
        not host
        or host in _HOSTED_ATS_DOMAINS
        or host.endswith(".myworkdayjobs.com")
    ):
        return None
    return host


def _domains_match(left: str, right: str) -> bool:
    return left == right or left.endswith(f".{right}") or right.endswith(f".{left}")


def resolve_identity(
    candidate: BoardCandidate,
    identities: list[CompanyIdentity],
) -> IdentityResolution:
    for identity in identities:
        for instance in identity.ats_instances:
            if (
                instance.get("ats_type", "").casefold() == candidate.ats_type.casefold()
                and instance.get("board_token", "").casefold()
                == candidate.board_token.casefold()
            ):
                return IdentityResolution(
                    "matched", identity.slug, "exact_ats_instance", 100.0
                )

    candidate_domain = _normalize_domain(candidate.employer_domain)
    if candidate_domain:
        for identity in identities:
            for value in identity.domains:
                known_domain = _normalize_domain(value)
                if known_domain and _domains_match(candidate_domain, known_domain):
                    return IdentityResolution(
                        "matched", identity.slug, "employer_domain", 100.0
                    )

    if candidate.company_name:
        best_identity: CompanyIdentity | None = None
        best_score = 0.0
        for identity in identities:
            for name in [identity.canonical_name, *identity.aliases]:
                score = float(fuzz.ratio(candidate.company_name, name))
                if score > best_score:
                    best_score = score
                    best_identity = identity
        if best_identity and best_score >= FUZZY_REVIEW_THRESHOLD:
            return IdentityResolution(
                "review_required",
                best_identity.slug,
                "fuzzy_name",
                round(best_score, 1),
            )

    return IdentityResolution("new_review_required", None, "no_safe_match")


def load_identity_file(path: Path) -> tuple[list[CompanyIdentity], list[dict[str, Any]]]:
    if not path.exists():
        return [], []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != IDENTITY_SCHEMA_VERSION:
        raise ValueError("unsupported company identity schema")
    identities_raw = raw.get("identities", [])
    pending_raw = raw.get("pending_review", [])
    if not isinstance(identities_raw, list) or not isinstance(pending_raw, list):
        raise ValueError("identity file lists are malformed")
    return (
        [CompanyIdentity.from_dict(item) for item in identities_raw],
        [dict(item) for item in pending_raw if isinstance(item, dict)],
    )


def save_identity_file(
    path: Path,
    identities: list[CompanyIdentity],
    pending_review: list[dict[str, Any]],
) -> None:
    payload = {
        "schema_version": IDENTITY_SCHEMA_VERSION,
        "identities": [
            identity.to_dict() for identity in sorted(identities, key=lambda item: item.slug)
        ],
        "pending_review": sorted(
            pending_review,
            key=lambda item: (
                str(item.get("ats_type", "")),
                str(item.get("board_token", "")),
            ),
        ),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
