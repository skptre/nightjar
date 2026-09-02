from __future__ import annotations

import logging
import math
import re
from dataclasses import replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol

from poller.discovery.common_crawl import format_utc
from poller.exceptions import SourceFetchError

if TYPE_CHECKING:
    from poller.discovery.models import BoardCandidate

logger = logging.getLogger(__name__)

_HTTP_STATUS_RE = re.compile(r"\bHTTP\s+(\d{3})\b", re.IGNORECASE)


class VerificationClient(Protocol):
    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
    ) -> Any: ...

    async def post_json(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        source: str = "",
        company_slug: str = "",
    ) -> Any: ...


class VerificationSchemaError(ValueError):
    pass


def _dict_jobs(data: Any) -> tuple[int, str | None]:
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
        raise VerificationSchemaError("response lacks a jobs list")
    company_name = data.get("company_name") or data.get("name")
    return len(data["jobs"]), company_name if isinstance(company_name, str) else None


async def _verify_greenhouse(
    client: VerificationClient, candidate: BoardCandidate,
) -> tuple[int, int, str | None]:
    data = await client.get_json(
        f"https://boards-api.greenhouse.io/v1/boards/{candidate.board_token}/jobs",
        source=candidate.ats_type,
        company_slug=candidate.board_token,
    )
    count, name = _dict_jobs(data)
    return count, 1, name


async def _verify_lever(
    client: VerificationClient, candidate: BoardCandidate,
) -> tuple[int, int, str | None]:
    domain = "api.eu.lever.co" if candidate.eu else "api.lever.co"
    data = await client.get_json(
        f"https://{domain}/v0/postings/{candidate.board_token}?mode=json",
        source=candidate.ats_type,
        company_slug=candidate.board_token,
    )
    if not isinstance(data, list):
        raise VerificationSchemaError("Lever response must be a list")
    return len(data), 1, None


async def _verify_ashby(
    client: VerificationClient, candidate: BoardCandidate,
) -> tuple[int, int, str | None]:
    data = await client.get_json(
        f"https://api.ashbyhq.com/posting-api/job-board/{candidate.board_token}",
        source=candidate.ats_type,
        company_slug=candidate.board_token,
    )
    count, name = _dict_jobs(data)
    return count, 1, name


async def _verify_smartrecruiters(
    client: VerificationClient, candidate: BoardCandidate,
) -> tuple[int, int, str | None]:
    data = await client.get_json(
        "https://api.smartrecruiters.com/v1/companies/"
        f"{candidate.board_token}/postings?limit=1",
        source=candidate.ats_type,
        company_slug=candidate.board_token,
    )
    if not isinstance(data, dict):
        raise VerificationSchemaError("SmartRecruiters response must be an object")
    total = data.get("totalFound")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise VerificationSchemaError("SmartRecruiters response lacks totalFound")
    return total, max(1, math.ceil(total / 100)), None


async def _verify_workday(
    client: VerificationClient, candidate: BoardCandidate,
) -> tuple[int, int, str | None]:
    parts = candidate.board_token.split("/", 1)
    if len(parts) != 2:
        raise VerificationSchemaError("Workday token must contain host/site")
    host, site = parts
    tenant = host.split(".", 1)[0]
    data = await client.post_json(
        f"https://{host}/wday/cxs/{tenant}/{site}/jobs",
        json_body={
            "appliedFacets": {},
            "limit": 1,
            "offset": 0,
            "searchText": "",
        },
        source=candidate.ats_type,
        company_slug=candidate.board_token,
    )
    if not isinstance(data, dict):
        raise VerificationSchemaError("Workday response must be an object")
    total = data.get("total")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise VerificationSchemaError("Workday response lacks total")
    return total, max(1, math.ceil(total / 20)), None


_VERIFIERS = {
    "greenhouse": _verify_greenhouse,
    "lever": _verify_lever,
    "ashby": _verify_ashby,
    "smartrecruiters": _verify_smartrecruiters,
    "workday": _verify_workday,
}


def _status_from_error(exc: SourceFetchError) -> int | None:
    match = _HTTP_STATUS_RE.search(str(exc))
    return int(match.group(1)) if match else None


async def verify_candidate(
    client: VerificationClient,
    candidate: BoardCandidate,
    *,
    now: datetime | None = None,
) -> BoardCandidate:
    verifier = _VERIFIERS.get(candidate.ats_type)
    if verifier is None:
        return replace(candidate, review_required=True, verification_status="review_required")

    timestamp = format_utc(now or datetime.now(UTC))
    try:
        count, cost, company_name = await verifier(client, candidate)
    except SourceFetchError as exc:
        status = _status_from_error(exc)
        state = "dead" if status in {404, 410} else "pending"
        logger.warning("verification failed for %s: %s", candidate.board_url, exc)
        return replace(
            candidate,
            verification_status=state,
            last_verified=timestamp,
            response_status=status,
            job_count_at_verification=None,
            estimated_poll_cost=None,
        )
    except VerificationSchemaError as exc:
        logger.warning("verification schema mismatch for %s: %s", candidate.board_url, exc)
        return replace(
            candidate,
            verification_status="pending",
            last_verified=timestamp,
            response_status=200,
            job_count_at_verification=None,
            estimated_poll_cost=None,
        )

    requires_review = candidate.ats_type == "workday"
    return replace(
        candidate,
        verification_status="review_required" if requires_review else "verified",
        review_required=requires_review,
        last_verified=timestamp,
        response_status=200,
        job_count_at_verification=count,
        estimated_poll_cost=cost,
        company_name=company_name or candidate.company_name,
    )
