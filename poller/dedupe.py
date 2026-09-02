from __future__ import annotations

import dataclasses
from collections import defaultdict
from datetime import datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from rapidfuzz.fuzz import token_sort_ratio

if TYPE_CHECKING:
    from poller.models import Posting

SOURCE_PRIORITY: dict[str, int] = {
    "greenhouse": 0,
    "lever": 1,
    "ashby": 2,
    "google_careers": 2,
    "microsoft_careers": 2,
    "smartrecruiters": 3,
    "recruitee": 3,
    "bamboohr": 3,
    "workable": 3,
    "breezy": 3,
    "jazzhr": 3,
    "teamtailor": 3,
    "pinpoint": 3,
    "comeet": 3,
    "workday": 4,
    "generic": 5,
    "simplify": 99,
}

TITLE_THRESHOLD = 95.0
DATE_WINDOW_DAYS = 30

_UNIVERSAL_STRIP_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source",
}

_PROVIDER_STRIP_PARAMS: dict[str, set[str]] = {
    "greenhouse": {"gh_src"},
    "lever": {"lever_origin", "lever_source"},
    "workday": {"source", "locale"},
}

_PROVIDER_CONDITIONAL_STRIP: dict[str, set[str]] = {
    "greenhouse": {"gh_jid"},
}


def canonicalize_url(
    url: str,
    *,
    provider: str = "",
    has_source_job_id: bool = False,
) -> str:
    if not url:
        return ""

    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = parsed.hostname or ""
    host = host.lower()
    port = parsed.port
    path = parsed.path.rstrip("/") or ""

    params_to_strip = set(_UNIVERSAL_STRIP_PARAMS)
    provider_key = provider.lower() if provider else ""
    if provider_key in _PROVIDER_STRIP_PARAMS:
        params_to_strip |= _PROVIDER_STRIP_PARAMS[provider_key]
    if has_source_job_id and provider_key in _PROVIDER_CONDITIONAL_STRIP:
        params_to_strip |= _PROVIDER_CONDITIONAL_STRIP[provider_key]

    query_dict = parse_qs(parsed.query, keep_blank_values=True)
    filtered: dict[str, list[str]] = {}
    for key, values in query_dict.items():
        if key.lower() not in params_to_strip:
            filtered[key] = values

    query_string = urlencode(
        sorted(
            ((k, v) for k, vals in filtered.items() for v in vals),
            key=lambda pair: pair[0],
        ),
    )

    netloc = f"{host}:{port}" if port else host

    return urlunparse((scheme, netloc, path, "", query_string, ""))


def _get_req_id(posting: Posting) -> str | None:
    if posting.source_metadata and isinstance(posting.source_metadata, dict):
        req_id = posting.source_metadata.get("requisition_id")
        if req_id and isinstance(req_id, str):
            return req_id
    return None


def _dates_within_window(a: Posting, b: Posting) -> bool:
    if a.posted_at is None or b.posted_at is None:
        return True
    try:
        dt_a = datetime.fromisoformat(a.posted_at.replace("Z", "+00:00"))
        dt_b = datetime.fromisoformat(b.posted_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return True
    delta = abs((dt_a - dt_b).days)
    return delta <= DATE_WINDOW_DAYS


def _locations_overlap(a: Posting, b: Posting) -> bool:
    if not a.location and not b.location:
        return True
    a_set = set(a.locations) if a.locations else {a.location} if a.location else set()
    b_set = set(b.locations) if b.locations else {b.location} if b.location else set()
    if not a_set and not b_set:
        return True
    return bool(a_set & b_set)


def _pick_canonical(a: Posting, b: Posting) -> tuple[Posting, Posting]:
    pri_a = SOURCE_PRIORITY.get(a.source, 99)
    pri_b = SOURCE_PRIORITY.get(b.source, 99)
    if pri_a <= pri_b:
        return a, b
    return b, a


def _make_provenance_entry(posting: Posting) -> dict[str, Any]:
    return {
        "source": posting.source,
        "source_job_id": posting.source_job_id,
        "url": posting.url,
        "discovered_at": posting.first_seen_at,
    }


def _get_existing_provenance(posting: Posting) -> list[dict[str, Any]]:
    if posting.source_metadata and isinstance(posting.source_metadata, dict):
        prov = posting.source_metadata.get("provenance", [])
        if isinstance(prov, list):
            return list(prov)
    return []


def _merge(canonical: Posting, discarded: Posting) -> Posting:
    earliest = min(canonical.first_seen_at, discarded.first_seen_at)
    merged_ids = list(canonical.merged_from) + [discarded.id]

    existing_prov = _get_existing_provenance(canonical)
    discard_prov = _get_existing_provenance(discarded)
    new_entry = _make_provenance_entry(discarded)

    combined_prov = existing_prov + discard_prov + [new_entry]

    seen_keys: set[tuple[str, str]] = set()
    deduped_prov: list[dict[str, Any]] = []
    for entry in combined_prov:
        key = (entry.get("source", ""), entry.get("source_job_id", ""))
        if key not in seen_keys:
            seen_keys.add(key)
            deduped_prov.append(entry)

    merged_metadata: dict[str, Any] = {}
    if canonical.source_metadata and isinstance(canonical.source_metadata, dict):
        merged_metadata.update(canonical.source_metadata)
    merged_metadata["provenance"] = deduped_prov

    return dataclasses.replace(
        canonical,
        first_seen_at=earliest,
        merged_from=merged_ids,
        source_metadata=merged_metadata,
    )


def _is_match(a: Posting, b: Posting) -> bool:
    if a.source == b.source:
        return False

    a_canon = canonicalize_url(a.url, provider=a.source, has_source_job_id=True)
    b_canon = canonicalize_url(b.url, provider=b.source, has_source_job_id=True)
    if a_canon and b_canon and a_canon == b_canon:
        return True

    req_a = _get_req_id(a)
    req_b = _get_req_id(b)
    if req_a and req_b:
        return req_a == req_b

    score = token_sort_ratio(a.title, b.title)
    if score < TITLE_THRESHOLD:
        return False

    if not _locations_overlap(a, b):
        return False

    return _dates_within_window(a, b)


def dedupe_postings(postings: list[Posting]) -> list[Posting]:
    groups: dict[str, list[Posting]] = defaultdict(list)
    for p in postings:
        groups[p.company_slug].append(p)

    result: list[Posting] = []

    for _slug, group in groups.items():
        if len(group) <= 1:
            result.extend(group)
            continue

        discarded_ids: set[str] = set()
        merged: dict[str, Posting] = {p.id: p for p in group}

        for i in range(len(group)):
            if group[i].id in discarded_ids:
                continue
            for j in range(i + 1, len(group)):
                if group[j].id in discarded_ids:
                    continue

                a = merged[group[i].id]
                b = merged[group[j].id]

                if not _is_match(a, b):
                    continue

                canonical, discard = _pick_canonical(a, b)
                merged[canonical.id] = _merge(canonical, discard)
                discarded_ids.add(discard.id)

        for posting_id, posting in merged.items():
            if posting_id not in discarded_ids:
                result.append(posting)

    return result
