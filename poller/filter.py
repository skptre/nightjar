"""Filter postings to internship/student roles and US locations.

Product-level filters — not user-specific. Nightjar is a US-focused
internship/student feed; non-student and non-US postings are noise.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from poller.models import Posting

logger = logging.getLogger(__name__)

_STUDENT_ROLE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in [
        # Internships and co-ops
        r"\bintern(?:ship)?s?\b",
        r"\bco[\s-]?op\b",
        r"\bcooperative\s+education\b",
        r"\bstudent\s+trainee\b",

        # Common internship-equivalent titles
        r"\bsummer\s+analyst\b",
        r"\bwinter\s+analyst\b",
        r"\bsummer\s+associate\b",

        # Explicit new-graduate programs. Generic "entry level" and
        # "early career" are deliberately excluded because they routinely
        # include experienced full-time roles.
        r"\bnew\s+grad(?:uate)?s?\b",
        r"\brecent\s+grad(?:uate)?s?\b",
        r"\bgraduate\s+(?:program(?:me)?|trainee)\b",
        r"\buniversity\s+(?:grad(?:uate)?|hire|recruit)",
        r"\bcampus\s+(?:grad(?:uate)?|hire|recruit)",
        r"\bfreshers?\b",
    ]
]


def is_student_role(title: str) -> bool:
    return any(p.search(title) for p in _STUDENT_ROLE_PATTERNS)


def filter_student_roles(postings: list[Posting]) -> list[Posting]:
    kept = [p for p in postings if is_student_role(p.title)]
    dropped = len(postings) - len(kept)
    logger.info(
        "filter: %d student/new-grad roles kept, %d non-student dropped",
        len(kept), dropped,
    )
    return kept


def filter_feed_mapping(postings: dict[str, Posting]) -> dict[str, Posting]:
    """Return only postings inside Nightjar's public feed scope.

    This is also used on historical feed data when the product scope changes.
    Out-of-scope history must not pass through normal closure retention, which
    is intended for upstream disappearances rather than policy migrations.
    """
    kept = {
        posting_id: posting
        for posting_id, posting in postings.items()
        if is_student_role(posting.title)
        and is_us_location(posting.location, posting.locations)
    }
    dropped = len(postings) - len(kept)
    if dropped:
        logger.info(
            "scope migration: %d historical postings kept, %d out-of-scope pruned",
            len(kept), dropped,
        )
    return kept


# ── US location filter ──────────────────────────────────────────────

_US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
}

_US_STATE_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
    "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york",
    "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
    "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington",
    "west virginia", "wisconsin", "wyoming", "district of columbia",
}

_US_COUNTRY_PATTERNS = re.compile(
    r"\bunited\s+states(?:\s+of\s+america)?\b"
    r"|\bu\.?s\.?a?\.?\b",
    re.IGNORECASE,
)

_STATE_ABBREV_RE = re.compile(
    r"(?:,\s*|\s+)(" + "|".join(sorted(_US_STATES)) + r")\b"
)

_STATE_NAME_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(name) for name in sorted(_US_STATE_NAMES)) + r")\b",
    re.IGNORECASE,
)


def is_us_location(location: str, locations: list[str]) -> bool:
    all_locs = locations + ([location] if location else [])

    if not all_locs or all(not loc.strip() for loc in all_locs):
        return False

    combined = " ; ".join(all_locs)

    if _US_COUNTRY_PATTERNS.search(combined):
        return True

    if _STATE_ABBREV_RE.search(combined):
        return True

    return _STATE_NAME_RE.search(combined) is not None


def filter_us_locations(postings: list[Posting]) -> list[Posting]:
    kept = [p for p in postings if is_us_location(p.location, p.locations)]
    dropped = len(postings) - len(kept)
    logger.info(
        "filter: %d explicitly US roles kept, %d non-US/unknown dropped",
        len(kept), dropped,
    )
    return kept
