"""Oracle Candidate Experience listing API on verified employer hosts."""

from __future__ import annotations

from typing import TYPE_CHECKING

from poller.exceptions import SourceFetchError, SourceParseError
from poller.models import Company, RawPosting, SourceConfig
from poller.normalize import html_to_plaintext
from poller.pagination import PaginationGuard
from poller.sources.public_careers import PublicCareersAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient


class OracleCareersAdapter(PublicCareersAdapter):
    async def fetch(
        self, client: RateLimitedClient, company: Company, source: SourceConfig
    ) -> list[RawPosting]:
        # Employer hostname, Oracle site number, and public vanity site.
        parts = source.board_token.split("/")
        if (
            len(parts) != 3
            or parts[0] != "enterpriseplatform.dell.com"
            or parts[1:] != ["CX_1001", "careers"]
        ):
            raise SourceParseError(
                "oracle_careers", company.slug, "unverified Oracle board configuration"
            )
        host, site, vanity = parts
        root = f"https://{host}"
        rows: dict[str, RawPosting] = {}
        guard = PaginationGuard("oracle_careers", company.slug)
        offset = 0
        self.potentially_truncated = False
        try:
            while True:
                data = await client.get_json(
                    root + "/hcmRestApi/resources/latest/recruitingCEJobRequisitions",
                    source="oracle_careers",
                    company_slug=company.slug,
                    params={
                        "onlyData": "true",
                        "expand": "requisitionList",
                        "finder": f"findReqs;siteNumber={site},limit=25,offset={offset}",
                    },
                )
                result = data["items"][0]
                jobs, total = result["requisitionList"], result["TotalJobsCount"]
                if not isinstance(jobs, list) or type(total) is not int or total < 0:
                    raise ValueError("invalid Oracle listing records or total")
                ids = []
                for job in jobs:
                    job_id, title = job["Id"], job["Title"]
                    if (
                        not isinstance(job_id, str)
                        or not job_id
                        or not isinstance(title, str)
                        or not title
                    ):
                        raise ValueError("missing Oracle listing identity")
                    ids.append(job_id)
                    location = job.get("PrimaryLocation") or ""
                    if job.get("PrimaryLocationCountry") == "US":
                        location += ", USA"
                    rows[job_id] = RawPosting(
                        source="oracle_careers",
                        company_slug=company.slug,
                        source_job_id=job_id,
                        title=title,
                        location=location,
                        locations=[location],
                        url=f"{root}/hcmUI/CandidateExperience/en/sites/{vanity}/job/{job_id}",
                        posted_at=job.get("PostedDate"),
                        description=html_to_plaintext(
                            "\n".join(
                                job.get(k) or ""
                                for k in (
                                    "ShortDescriptionStr",
                                    "ExternalResponsibilitiesStr",
                                    "ExternalQualificationsStr",
                                )
                            )
                        ),
                    )
                if guard.observe(ids, total, terminal=not jobs):
                    break
                offset += len(jobs)
        except (
            SourceFetchError,
            SourceParseError,
            ValueError,
            KeyError,
            TypeError,
            IndexError,
        ) as exc:
            if not rows:
                raise SourceParseError("oracle_careers", company.slug, str(exc)) from exc
            self.potentially_truncated = True
        return list(rows.values())
