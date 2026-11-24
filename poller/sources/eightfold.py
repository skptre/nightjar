"""Public Eightfold career-site search contracts (legacy and PCSX)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import urljoin, urlparse

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import is_public_hostname
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, html_to_plaintext, normalize_locations
from poller.pagination import PaginationGuard
from poller.sources.base import SourceAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient


class EightfoldAdapter(SourceAdapter):
    async def fetch(
        self, client: RateLimitedClient, company: Company, source: SourceConfig
    ) -> list[RawPosting]:
        host, separator, domain = source.board_token.partition("/")
        if not separator or not is_public_hostname(host) or not is_public_hostname(domain):
            raise SourceParseError("eightfold", company.slug, "invalid host/domain configuration")
        endpoint = "api/apply/v2/jobs" if host == "explore.jobs.netflix.net" else "api/pcsx/search"
        guard = PaginationGuard("eightfold", company.slug, page_size=10)
        rows: dict[str, RawPosting] = {}
        offset = 0
        self.potentially_truncated = False
        try:
            while True:
                response = await client.get_json(
                    f"https://{host}/{endpoint}",
                    params={"domain": domain, "start": str(offset), "num": "10"},
                    source="eightfold",
                    company_slug=company.slug,
                )
                error = response.get("error") if isinstance(response, dict) else None
                if not isinstance(response, dict) or (
                    error
                    and (not isinstance(error, dict) or error.get("message") or error.get("body"))
                ):
                    raise SourceParseError("eightfold", company.slug, "invalid search response")
                data = response.get("data", response)
                if not isinstance(data, dict) or not isinstance(data.get("positions"), list):
                    raise SourceParseError("eightfold", company.slug, "missing positions")
                count = data.get("count")
                if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                    raise SourceParseError("eightfold", company.slug, "invalid result count")
                ids = []
                for job in data["positions"]:
                    if not isinstance(job, dict) or job.get("id") is None or not job.get("name"):
                        raise SourceParseError(
                            "eightfold", company.slug, "invalid position identity"
                        )
                    job_id = str(job["id"])
                    url = urljoin(
                        f"https://{host}",
                        job.get("canonicalPositionUrl")
                        or job.get("positionUrl")
                        or f"/careers/job/{job_id}",
                    )
                    if urlparse(url).hostname != host:
                        raise SourceParseError(
                            "eightfold", company.slug, "position URL changed host"
                        )
                    locations = job.get("locations") or [job.get("location", "")]
                    if not isinstance(locations, list) or not all(
                        isinstance(x, str) for x in locations
                    ):
                        raise SourceParseError(
                            "eightfold", company.slug, "invalid position locations"
                        )
                    ids.append(job_id)
                    posted = job.get("postedTs") or job.get("t_create")
                    rows[job_id] = RawPosting(
                        source="eightfold",
                        company_slug=company.slug,
                        source_job_id=job_id,
                        title=job["name"],
                        location=locations[0] if locations else "",
                        locations=locations,
                        url=url,
                        posted_at=(
                            datetime.fromtimestamp(posted, UTC).isoformat()
                            if isinstance(posted, (int, float))
                            else None
                        ),
                        description=str(job.get("job_description") or ""),
                        raw_data=job,
                        department=job.get("department"),
                    )
                if guard.observe(ids, count, terminal=not ids):
                    break
                offset += len(ids)
        except (SourceFetchError, SourceParseError):
            if not rows:
                raise
            self.potentially_truncated = True
        return list(rows.values())

    def normalize(self, raw: RawPosting, company: Company, now: str) -> Posting:
        locations = normalize_locations(raw.locations)
        return Posting(
            id=compute_posting_id(raw.source, raw.company_slug, raw.source_job_id),
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=locations[0] if locations else "",
            locations=locations,
            url=raw.url,
            source=raw.source,
            source_job_id=raw.source_job_id,
            ats="eightfold",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=html_to_plaintext(raw.description),
            department=raw.department,
        )
