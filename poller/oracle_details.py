"""Oracle's anonymous candidate-site detail contract, restricted to the page's job."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlencode, urlparse

from poller.normalize import html_to_plaintext
from poller.page_document import JobDocument, _Document, normalized_title, title_is_shortening

FIELDS = (
    "Id",
    "Title",
    "ExternalDescriptionStr",
    "ExternalResponsibilitiesStr",
    "ExternalQualificationsStr",
    "CorporateDescriptionStr",
    "OrganizationDescriptionStr",
)


def detail_endpoint(html: str, url: str) -> tuple[str, str] | None:
    parsed = urlparse(url)
    if not re.fullmatch(r"[a-z0-9-]+\.fa\.[a-z0-9]+\.oraclecloud\.com", parsed.hostname or ""):
        return None
    path = re.fullmatch(
        r"/hcmUI/CandidateExperience/[a-zA-Z_-]+/sites/[^/]+/job/([A-Za-z0-9_-]+)/?", parsed.path
    )
    if not path:
        return None
    tree = _Document(html)
    sites = {
        node.attrs["data-sitenumber"]
        for node in tree.root.walk()
        if node.tag == "base" and "data-sitenumber" in node.attrs
    }
    if len(sites) != 1:
        return None
    site = sites.pop()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", site):
        return None
    query = urlencode(
        {
            "onlyData": "true",
            "fields": ",".join(FIELDS),
            "finder": f'ById;Id="{path[1]}",siteNumber={site}',
        }
    )
    return (
        f"https://{parsed.hostname}/hcmRestApi/resources/latest/"
        f"recruitingCEJobRequisitionDetails?{query}",
        path[1],
    )


def parse_detail(body: str, job_id: str, title: str) -> JobDocument:
    data: Any = json.loads(body)
    rows = data.get("items") if isinstance(data, dict) else None
    if not isinstance(rows, list) or len(rows) != 1 or data.get("hasMore"):
        raise ValueError("oracle_description_identity_mismatch")
    job = rows[0]
    if (
        not isinstance(job, dict)
        or str(job.get("Id")) != job_id
        or not isinstance(job.get("Title"), str)
        or not title_is_shortening(normalized_title(title), job["Title"])
    ):
        raise ValueError("oracle_description_identity_mismatch")
    if not job.get("ExternalDescriptionStr"):
        raise ValueError("empty_oracle_description")
    parts = []
    for field in FIELDS[2:]:
        value = job.get(field)
        if isinstance(value, str) and value.strip():
            heading = {
                "ExternalResponsibilitiesStr": "Responsibilities",
                "ExternalQualificationsStr": "Qualifications",
                "CorporateDescriptionStr": "About the company",
                "OrganizationDescriptionStr": "About the organization",
            }.get(field)
            parts.append((f"<h2>{heading}</h2>" if heading else "") + value)
    # Missing schema fields cannot certify completeness. Null is a legitimate absence.
    status = "available" if all(field in job for field in FIELDS) else "partial"
    return JobDocument(html_to_plaintext("\n".join(parts)), status, "oracle_public_api")
