from __future__ import annotations

import dataclasses
from collections import defaultdict
from typing import TYPE_CHECKING

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
    "simplify": 99,
}

TITLE_THRESHOLD = 95.0


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


def _merge(canonical: Posting, discarded: Posting) -> Posting:
    earliest = min(canonical.first_seen_at, discarded.first_seen_at)
    merged_ids = list(canonical.merged_from) + [discarded.id]
    return dataclasses.replace(
        canonical,
        first_seen_at=earliest,
        merged_from=merged_ids,
    )


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

                if a.source == b.source:
                    continue

                score = token_sort_ratio(a.title, b.title)
                if score < TITLE_THRESHOLD:
                    continue

                if not _locations_overlap(a, b):
                    continue

                canonical, discard = _pick_canonical(a, b)
                merged[canonical.id] = _merge(canonical, discard)
                discarded_ids.add(discard.id)

        for posting_id, posting in merged.items():
            if posting_id not in discarded_ids:
                result.append(posting)

    return result
