from __future__ import annotations

import argparse
import asyncio
import json
import logging
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from poller.discovery.catalog import (
    generate_registry_candidates,
    load_catalog,
    load_registry_candidates,
    merge_catalog,
    save_catalog,
    save_registry_candidates,
)
from poller.discovery.common_crawl import (
    DEFAULT_CANDIDATE_BUDGET,
    DiscoveryBatch,
    discover_common_crawl,
    format_utc,
)
from poller.discovery.directories import extract_directory_domains
from poller.discovery.identity import (
    load_identity_file,
    resolve_identity,
    save_identity_file,
)
from poller.discovery.redirect_detect import discover_redirects
from poller.discovery.verify import verify_candidate
from poller.http import RateLimitedClient
from poller.registry import load_registry

if TYPE_CHECKING:
    from poller.discovery.models import BoardCandidate

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT_DIR / "data"


class DiscoveryPipelineClient(Protocol):
    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> Any: ...

    async def get_text(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> str: ...

    async def post_json(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        source: str = "",
        company_slug: str = "",
    ) -> Any: ...

    async def resolve_url(
        self,
        url: str,
        *,
        source: str = "",
        company_slug: str = "",
        max_redirects: int = 3,
    ) -> tuple[str, int]: ...


@dataclass(frozen=True)
class DiscoverySummary:
    discovered: int
    verified: int
    dead: int
    review_required: int
    registry_candidates_added: int


def _load_directory_records(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("directory input must contain a JSON list")
    return [dict(item) for item in raw if isinstance(item, dict)]


def _review_record(
    candidate: BoardCandidate,
    *,
    status: str,
    proposed_identity_slug: str | None,
    reason: str,
    score: float | None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "ats_type": candidate.ats_type,
        "board_token": candidate.board_token,
        "board_url": candidate.board_url,
        "company_name": candidate.company_name,
        "employer_domain": candidate.employer_domain,
        "resolution_status": status,
        "reason": reason,
    }
    if proposed_identity_slug:
        record["proposed_identity_slug"] = proposed_identity_slug
    if score is not None:
        record["similarity_score"] = score
    return record


async def _run_with_client(
    client: DiscoveryPipelineClient,
    *,
    data_dir: Path,
    registry_path: Path | None,
    directory_records_path: Path | None,
    max_candidates: int,
    verify: bool,
    now: datetime,
) -> DiscoverySummary:
    companies = load_registry(registry_path)
    known_source_keys = {
        (source.type, source.board_token)
        for company in companies
        for source in company.sources
    }

    batch: DiscoveryBatch = await discover_common_crawl(
        client,
        known_source_keys=known_source_keys,
        max_candidates=max_candidates,
        now=now,
    )
    incoming = list(batch.candidates)

    directory_records = _load_directory_records(directory_records_path)
    if directory_records:
        domains = extract_directory_domains(directory_records, source="structured_directory")
        redirected = await discover_redirects(domains, client, now=now)
        incoming.extend(
            replace(
                candidate,
                discovery_sources=sorted(
                    set([*candidate.discovery_sources, "directory"])
                ),
            )
            for candidate in redirected
            if candidate.key not in known_source_keys
        )

    deduped = {candidate.key: candidate for candidate in incoming}
    new_candidates = sorted(deduped.values(), key=lambda candidate: candidate.key)
    if verify:
        verified_candidates = [
            await verify_candidate(client, candidate, now=now)
            for candidate in new_candidates
        ]
    else:
        verified_candidates = new_candidates

    catalog_path = data_dir / "discovered_boards.json"
    existing_catalog = load_catalog(catalog_path)
    merged = merge_catalog(existing_catalog, verified_candidates, now=now)

    identity_path = data_dir / "company_identities.json"
    identities, _existing_review = load_identity_file(identity_path)
    pending_review: list[dict[str, Any]] = []
    resolved_catalog: list[BoardCandidate] = []
    for candidate in merged:
        resolution = resolve_identity(candidate, identities)
        if resolution.status == "matched":
            resolved_catalog.append(
                replace(candidate, identity_slug=resolution.identity_slug)
            )
        else:
            resolved_catalog.append(candidate)
            pending_review.append(
                _review_record(
                    candidate,
                    status=resolution.status,
                    proposed_identity_slug=resolution.identity_slug,
                    reason=resolution.reason,
                    score=resolution.score,
                )
            )

    status_counts: dict[str, int] = {}
    for candidate in resolved_catalog:
        status_counts[candidate.verification_status] = (
            status_counts.get(candidate.verification_status, 0) + 1
        )
    metrics: dict[str, Any] = batch.metrics.to_dict()
    metrics.update(
        {
            "catalog_count": len(resolved_catalog),
            "verified_count": status_counts.get("verified", 0),
            "dead_count": status_counts.get("dead", 0),
            "review_required_count": status_counts.get("review_required", 0),
            "active_board_yield": sum(
                1
                for candidate in verified_candidates
                if (candidate.job_count_at_verification or 0) > 0
            ),
            "duplication_rate_pct": round(
                batch.metrics.duplicates / batch.metrics.raw_urls * 100,
                1,
            )
            if batch.metrics.raw_urls
            else 0.0,
            "verification_success_rate_pct": round(
                sum(
                    candidate.verification_status == "verified"
                    for candidate in verified_candidates
                )
                / len(verified_candidates)
                * 100,
                1,
            )
            if verified_candidates
            else 0.0,
        }
    )

    timestamp = format_utc(now)
    save_catalog(
        catalog_path,
        resolved_catalog,
        generated_at=timestamp,
        metrics=metrics,
    )
    save_identity_file(identity_path, identities, pending_review)

    registry_candidates_path = data_dir / "registry_candidates.json"
    existing_registry_candidates = load_registry_candidates(registry_candidates_path)
    generated = generate_registry_candidates(
        resolved_catalog,
        existing=existing_registry_candidates,
    )
    save_registry_candidates(registry_candidates_path, generated)

    added = len(generated) - len(existing_registry_candidates)
    return DiscoverySummary(
        discovered=len(new_candidates),
        verified=sum(
            candidate.verification_status == "verified"
            for candidate in verified_candidates
        ),
        dead=sum(
            candidate.verification_status == "dead"
            for candidate in verified_candidates
        ),
        review_required=sum(
            candidate.verification_status == "review_required"
            for candidate in verified_candidates
        ),
        registry_candidates_added=added,
    )


async def run_discovery(
    *,
    data_dir: Path | None = None,
    registry_path: Path | None = None,
    directory_records_path: Path | None = None,
    max_candidates: int = DEFAULT_CANDIDATE_BUDGET,
    verify: bool = True,
    client: DiscoveryPipelineClient | None = None,
    now: datetime | None = None,
) -> DiscoverySummary:
    resolved_data = data_dir or DATA_DIR
    run_now = now or datetime.now(UTC)
    if client is not None:
        return await _run_with_client(
            client,
            data_dir=resolved_data,
            registry_path=registry_path,
            directory_records_path=directory_records_path,
            max_candidates=max_candidates,
            verify=verify,
            now=run_now,
        )
    async with RateLimitedClient() as owned_client:
        return await _run_with_client(
            owned_client,
            data_dir=resolved_data,
            registry_path=registry_path,
            directory_records_path=directory_records_path,
            max_candidates=max_candidates,
            verify=verify,
            now=run_now,
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the bounded Nightjar career-board discovery pipeline"
    )
    parser.add_argument(
        "--max-candidates",
        type=int,
        default=DEFAULT_CANDIDATE_BUDGET,
    )
    parser.add_argument("--skip-verify", action="store_true")
    parser.add_argument("--directory-records", type=Path)
    return parser


def main() -> None:
    args = _parser().parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    summary = asyncio.run(
        run_discovery(
            max_candidates=args.max_candidates,
            verify=not args.skip_verify,
            directory_records_path=args.directory_records,
        )
    )
    logger.info(
        "discovery complete: %d discovered, %d verified, %d registry candidates",
        summary.discovered,
        summary.verified,
        summary.registry_candidates_added,
    )


if __name__ == "__main__":
    main()
