"""Observed public SSR/JSON listing contracts; no JavaScript execution."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from poller.exceptions import SourceFetchError, SourceParseError
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, html_to_plaintext, normalize_locations
from poller.pagination import PaginationGuard
from poller.sources.base import SourceAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient


class PublicCareersAdapter(SourceAdapter):
    async def fetch(
        self, client: RateLimitedClient, company: Company, source: SourceConfig
    ) -> list[RawPosting]:
        parsed = urlparse(source.board_token)
        host = parsed.hostname
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or host not in {"www.google.com", "jobs.apple.com", "www.amazon.jobs", "amazon.jobs"}
        ):
            raise SourceParseError("public_careers", company.slug, "unsupported public listing URL")
        rows: dict[str, RawPosting] = {}
        guard = PaginationGuard("public_careers", company.slug)
        offset = 0
        page = 1
        self.potentially_truncated = False
        try:
            while True:
                params = dict(parse_qsl(parsed.query)) if host != "www.google.com" else None
                if host in {"amazon.jobs", "www.amazon.jobs"}:
                    query = {
                        **(params or {}),
                        "offset": str(offset),
                        "result_limit": "10",
                        "sort": "recent",
                    }
                    data = await client.get_json(
                        urlunparse(parsed._replace(query=urlencode(query))),
                        source="public_careers",
                        company_slug=company.slug,
                    )
                    jobs, total = data.get("jobs"), data.get("hits")
                else:
                    # Retain repeated Google target_level parameters.
                    query_pairs = [(k, v) for k, v in parse_qsl(parsed.query) if k != "page"]
                    query_pairs.append(("page", str(page)))
                    body = await client.get_text(
                        urlunparse(parsed._replace(query=urlencode(query_pairs))),
                        source="public_careers",
                        company_slug=company.slug,
                    )
                    if host == "www.google.com":
                        match = re.search(
                            r"AF_initDataCallback\(\{key:\s*'ds:1'.*?data:\s*", body, re.S
                        )
                        if not match:
                            raise ValueError("missing Google listing dataset")
                        data, _ = json.JSONDecoder().raw_decode(body[match.end() :])
                        jobs, total = data[0], data[2]
                    else:
                        match = re.search(
                            r"window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*", body
                        )
                        if not match:
                            raise ValueError("missing Apple listing dataset")
                        encoded, _ = json.JSONDecoder().raw_decode(body[match.end() :])
                        data = json.loads(encoded)["loaderData"]["search"]
                        jobs, total = data.get("searchResults"), data.get("totalRecords")
                if (
                    not isinstance(jobs, list)
                    or isinstance(total, bool)
                    or not isinstance(total, int)
                    or total < 0
                ):
                    raise ValueError("invalid public listing count or records")
                ids = []
                for job in jobs:
                    raw = self._parse(job, host, company)
                    if not raw.source_job_id or not raw.title or not raw.url:
                        raise ValueError("missing listing identity")
                    if (
                        host == "jobs.apple.com"
                        and (params or {}).get("team") == "internships-STDNT-INTRN"
                    ):
                        raw.employment_type = "Internship"
                    ids.append(raw.source_job_id)
                    rows[raw.source_job_id] = raw
                if guard.observe(ids, total, terminal=not jobs):
                    break
                offset += len(jobs)
                page += 1
        except (
            SourceFetchError,
            SourceParseError,
            ValueError,
            KeyError,
            TypeError,
            IndexError,
        ) as exc:
            if not rows:
                raise SourceParseError("public_careers", company.slug, str(exc)) from exc
            self.potentially_truncated = True
        return list(rows.values())

    def _parse(self, job: Any, host: str, company: Company) -> RawPosting:
        employment_type = None
        if host == "www.google.com":
            job_id, title = str(job[0]), job[1]
            url = f"https://www.google.com/about/careers/applications/jobs/results/{job_id}"
            locations = [loc[0] for loc in job[9] if isinstance(loc, list) and loc]
            parts = [
                job[i][1]
                for i in (3, 4, 10, 19)
                if len(job) > i
                and isinstance(job[i], list)
                and len(job[i]) > 1
                and isinstance(job[i][1], str)
            ]
            metadata = {"public_contract": "google_ssr"}
        elif host == "jobs.apple.com":
            job_id = str(job.get("id") or job["positionId"])
            title = job["postingTitle"]
            url = f"https://jobs.apple.com/en-us/details/{job_id}"
            locations = [
                ", ".join(
                    filter(
                        None,
                        [
                            str(loc.get("city") or loc.get("name") or ""),
                            str(loc.get("stateProvince") or ""),
                            str(loc.get("countryName") or ""),
                        ],
                    )
                )
                for loc in job.get("locations", [])
            ]
            parts = [job.get("jobSummary", "")]
            metadata = {"public_contract": "apple_ssr"}
        else:
            job_id = str(job.get("id_icims") or job["id"])
            title = job["title"]
            url = urljoin("https://www.amazon.jobs", job["job_path"])
            location = str(job.get("normalized_location") or job.get("location") or "")
            if job.get("country_code") in {"US", "USA"}:
                location = ", ".join(str(job[k]) for k in ("city", "state") if job.get(k)) + ", USA"
            elif job.get("country_code") == "CAN":
                location = (
                    ", ".join(str(job[k]) for k in ("city", "state") if job.get(k)) + ", Canada"
                )
            locations = [location]
            other_locations = job.get("locations") or []
            if isinstance(other_locations, str):
                other_locations = json.loads(other_locations)
            if not isinstance(other_locations, list):
                raise ValueError("invalid Amazon additional locations")
            for loc in other_locations:
                if isinstance(loc, str):
                    loc = json.loads(loc)
                if not isinstance(loc, dict):
                    raise ValueError("invalid Amazon location record")
                text = loc.get("normalizedLocation") or loc.get("location")
                country_name = loc.get("normalizedCountryName")
                if text and country_name and str(country_name) not in str(text):
                    text = f"{text}, {country_name}"
                if text and text not in locations:
                    locations.append(str(text))
            parts = [
                job.get(k, "")
                for k in ("description", "basic_qualifications", "preferred_qualifications")
            ]
            metadata = {"public_contract": "amazon_json"}
            employment_type = "Internship" if job.get("is_intern") else None
        return RawPosting(
            source="public_careers",
            company_slug=company.slug,
            source_job_id=job_id,
            title=title,
            url=url,
            posted_at=None,
            location=locations[0] if locations else "",
            locations=locations,
            description="\n\n".join(html_to_plaintext(p) for p in parts if isinstance(p, str)),
            employment_type=employment_type,
            raw_data=metadata,
        )

    def normalize(self, raw: RawPosting, company: Company, now: str) -> Posting:
        locations = normalize_locations(raw.locations)
        return Posting(
            id=compute_posting_id(raw.source, company.slug, raw.source_job_id),
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=locations[0] if locations else "",
            locations=locations,
            url=raw.url,
            source=raw.source,
            source_job_id=raw.source_job_id,
            ats="other",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            employment_type=raw.employment_type,
            source_metadata=raw.raw_data,
        )
