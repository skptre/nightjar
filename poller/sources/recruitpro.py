"""Public RecruitPro board contract; completeness is checked against jobCount."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from poller.exceptions import SourceParseError
from poller.models import Company, RawPosting, SourceConfig
from poller.sources.public_careers import PublicCareersAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient


class RecruitProAdapter(PublicCareersAdapter):
    async def fetch(
        self, client: RateLimitedClient, company: Company, source: SourceConfig
    ) -> list[RawPosting]:
        if source.board_token != "calstart.recruitpro.com/659":
            raise SourceParseError("recruitpro", company.slug, "unverified RecruitPro board")
        host, domain_id = source.board_token.split("/")
        payload = await client.get_json(
            f"https://{host}/core/jobs/{domain_id}",
            source="recruitpro",
            company_slug=company.slug,
            params={
                "getParams": json.dumps(
                    {
                        "cityUrl": "",
                        "countryAbbreviation": "",
                        "stateAbbreviation": "",
                        "isInternal": 0,
                        "showPayFrequency": 1,
                        "showLocation": 1,
                    }
                )
            },
        )
        try:
            data = payload["data"]
            jobs, count = data["jobs"], data["jobCount"]
            if (
                payload.get("success") is not True
                or not isinstance(jobs, list)
                or type(count) is not int
                or count < 0
            ):
                raise ValueError("invalid RecruitPro listing response")
            self.potentially_truncated = len(jobs) != count
            rows = []
            ids: set[str] = set()
            for job in jobs:
                url, title = job["jobUrl"], job["title"]
                parsed = urlparse(url)
                if (
                    parsed.scheme != "https"
                    or parsed.hostname != host
                    or not title
                    or not parsed.path
                ):
                    raise ValueError("invalid RecruitPro listing identity")
                job_id = parsed.path.rstrip("/").split("/")[-1]
                if job_id in ids:
                    raise ValueError("duplicate RecruitPro listing identity")
                ids.add(job_id)
                location = ", ".join(
                    str(job[k]) for k in ("city", "abbreviation", "iso3") if job.get(k)
                )
                rows.append(
                    RawPosting(
                        source="recruitpro",
                        company_slug=company.slug,
                        source_job_id=job_id,
                        title=title,
                        url=url,
                        location=location,
                        locations=[location],
                        posted_at=None,
                        description="",
                        employment_type=job.get("employmentType"),
                    )
                )
            return rows
        except (KeyError, TypeError, ValueError) as exc:
            raise SourceParseError("recruitpro", company.slug, str(exc)) from exc
