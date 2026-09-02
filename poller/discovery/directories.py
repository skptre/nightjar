from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from poller.http import is_public_hostname

_WEBSITE_FIELDS = ("website", "website_url")
_HOSTED_ATS_DOMAINS = {
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.eu.lever.co",
    "jobs.ashbyhq.com",
    "jobs.smartrecruiters.com",
}


def normalize_public_domain(value: str) -> str | None:
    candidate = value.strip()
    if not candidate:
        return None
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return None
    host = (parsed.hostname or "").casefold().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if (
        not host
        or not is_public_hostname(host)
        or host in _HOSTED_ATS_DOMAINS
        or host.endswith(".myworkdayjobs.com")
    ):
        return None
    return host


def extract_directory_domains(
    records: list[dict[str, Any]],
    *,
    source: str,
) -> list[str]:
    """Extract explicit websites from a structured public directory response.

    `source` is required so callers keep provenance even though this pure helper
    only returns the normalized domains. It deliberately does not scrape HTML.
    """
    if not source.strip():
        raise ValueError("directory source is required")
    domains: set[str] = set()
    for record in records:
        for field in _WEBSITE_FIELDS:
            value = record.get(field)
            if isinstance(value, str):
                domain = normalize_public_domain(value)
                if domain:
                    domains.add(domain)
                break
    return sorted(domains)
