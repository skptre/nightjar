from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from poller.description_enrich import _workday_detail_url, detect_ats_from_url
from poller.exceptions import SourceParseError
from poller.models import Posting, RawPosting, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from pathlib import Path

    from poller.http import RateLimitedClient
    from poller.models import Company, SourceConfig

SIMPLIFY_URL = (
    "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships"
    "/dev/.github/scripts/listings.json"
)

_SLUG_UNSAFE = re.compile(r"[^a-z0-9]+")
_MULTI_HYPHEN = re.compile(r"-{2,}")



def slugify_company(name: str) -> str:
    slug = _SLUG_UNSAFE.sub("-", name.lower().strip())
    slug = _MULTI_HYPHEN.sub("-", slug)
    return slug.strip("-")


def infer_ats_from_url(url: str) -> tuple[str, str | None]:
    provider = detect_ats_from_url(url)
    if not provider:
        return "other", None
    parsed = urlparse(url)
    if provider == "workday":
        detail = _workday_detail_url(url)
        assert detail is not None
        site = urlparse(detail).path.split("/")[4]
        return provider, f"{parsed.hostname}/{site}"
    if provider == "greenhouse" and parsed.hostname not in {
        "boards.greenhouse.io", "job-boards.greenhouse.io",
    }:
        return provider, None
    if provider in {"icims", "jazzhr"}:
        return provider, (parsed.hostname or "").split(".")[0]
    return provider, parsed.path.strip("/").split("/")[0]



class SimplifyAdapter(SourceAdapter):

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        data = await client.get_json(
            SIMPLIFY_URL,
            source="simplify",
            company_slug="__simplify__",
            allow_plain_text=True,
        )

        if not isinstance(data, list):
            raise SourceParseError(
                "simplify",
                "__simplify__",
                f"expected JSON array, got {type(data).__name__}",
            )

        raw_postings: list[RawPosting] = []
        for listing in data:
            if not listing.get("active") or not listing.get("is_visible"):
                continue
            try:
                raw_postings.append(self._parse_listing(listing))
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning(
                    "[simplify] skipping malformed listing: %s", exc,
                )

        logger.info(
            "[simplify] %d active+visible from %d total",
            len(raw_postings), len(data),
        )
        return raw_postings

    def _parse_listing(self, listing: dict[str, Any]) -> RawPosting:
        company_name = listing["company_name"].strip()
        company_slug = slugify_company(company_name)
        url = listing["url"]
        locations_raw: list[str] = listing.get("locations") or []

        date_posted = listing.get("date_posted")
        posted_at: str | None = None
        if date_posted and isinstance(date_posted, (int, float)):
            posted_at = datetime.fromtimestamp(
                date_posted, tz=UTC,
            ).strftime("%Y-%m-%dT%H:%M:%SZ")

        return RawPosting(
            source="simplify",
            company_slug=company_slug,
            source_job_id=str(listing["id"]),
            title=listing["title"],
            location=locations_raw[0] if locations_raw else "",
            locations=list(locations_raw),
            url=url,
            posted_at=posted_at,
            description="",
            raw_data={
                "company_name": company_name,
                "sponsorship": listing.get("sponsorship"),
                "terms": listing.get("terms") or [],
                "degrees": listing.get("degrees") or [],
                "category": listing.get("category") or "",
                "date_updated": listing.get("date_updated"),
            },
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        ats, _ = infer_ats_from_url(raw.url)
        posting_id = compute_posting_id(
            raw.source, raw.company_slug, raw.source_job_id,
        )

        metadata: dict[str, Any] = {}
        if raw.raw_data.get("sponsorship"):
            metadata["sponsorship"] = raw.raw_data["sponsorship"]
        if raw.raw_data.get("terms"):
            metadata["terms"] = raw.raw_data["terms"]
        if raw.raw_data.get("degrees"):
            metadata["degrees"] = raw.raw_data["degrees"]
        if raw.raw_data.get("category"):
            metadata["category"] = raw.raw_data["category"]

        return Posting(
            id=posting_id,
            company=raw.raw_data.get("company_name", raw.company_slug),
            company_slug=raw.company_slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="simplify",
            source_job_id=raw.source_job_id,
            ats=ats,
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            source_metadata=metadata if metadata else None,
        )


def generate_registry_candidates(
    postings: list[Posting],
    known_slugs: set[str],
    output_path: Path,
) -> None:
    by_company: dict[str, list[Posting]] = defaultdict(list)
    for p in postings:
        if p.source != "simplify":
            continue
        if p.company_slug in known_slugs:
            continue
        by_company[p.company_slug].append(p)

    candidates: list[dict[str, Any]] = []
    for slug, company_postings in sorted(by_company.items()):
        ats_val: str | None = None
        token_val: str | None = None
        url_val: str | None = None

        for p in company_postings:
            ats, token = infer_ats_from_url(p.url)
            if ats != "other":
                ats_val = ats
                token_val = token
                url_val = p.url
                break

        if ats_val is None:
            continue

        candidates.append({
            "slug": slug,
            "name": company_postings[0].company,
            "inferred_ats": ats_val,
            "inferred_board_token": token_val,
            "apply_url": url_val,
            "posting_count": len(company_postings),
        })

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(candidates, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    logger.info(
        "[simplify] wrote %d registry candidates to %s",
        len(candidates), output_path,
    )
