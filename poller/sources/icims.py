"""iCIMS adapter — parses the public iCIMS careers search HTML.

iCIMS has no public JSON API, but each employer's career site renders a
server-side job list at:
    https://careers-{token}.icims.com/jobs/search?pr={page}&in_iframe=1

board_token is the iCIMS subdomain label (e.g. "jobyaviation" for
careers-jobyaviation.icims.com). Each job card looks like:

    <li class="iCIMS_JobCardItem">
      <span class="sr-only field-label">Job Locations</span>
      <span>US-CA-Marina</span>
      <a class="iCIMS_Anchor" href=".../jobs/5010/slug/job?in_iframe=1">
        <h3>Additive Production Technician</h3>
      </a>
    </li>

Uses only the stdlib HTMLParser (no new dependency), matching generic.py.
The product-level internship/US filter runs downstream in filter.py.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import TYPE_CHECKING

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import USER_AGENT
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter
from poller.sources.generic import RobotsPolicy

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

ICIMS_SEARCH = "https://careers-{token}.icims.com/jobs/search"
MAX_PAGES = 50
_JOB_ID_RE = re.compile(r"/jobs/(\d+)/[^/]+/job")


@dataclass
class _Card:
    job_id: str = ""
    url: str = ""
    title_parts: list[str] = field(default_factory=list)
    location: str = ""

    @property
    def title(self) -> str:
        return " ".join(" ".join(self.title_parts).split())


class _JobCardParser(HTMLParser):
    """Extracts (job_id, url, title, location) from an iCIMS search page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[_Card] = []
        self._card: _Card | None = None
        self._in_anchor = False
        self._in_title = False
        self._in_label = False
        self._label_buf = ""
        self._expect_location = False
        self._in_location_value = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        classes = a.get("class", "")

        if tag == "li" and "iCIMS_JobCardItem" in classes:
            self._card = _Card()
            self._expect_location = False
            return

        if self._card is None:
            return

        if tag == "span" and "field-label" in classes:
            self._in_label = True
            self._label_buf = ""
            return

        if tag == "span" and self._expect_location:
            self._in_location_value = True
            return

        if tag == "a" and "iCIMS_Anchor" in classes:
            href = a.get("href", "")
            m = _JOB_ID_RE.search(href)
            if m:
                self._card.job_id = m.group(1)
                self._card.url = href.split("?")[0]
                self._in_anchor = True
            return

        if tag == "h3" and self._in_anchor:
            self._in_title = True

    def handle_data(self, data: str) -> None:
        if self._in_label:
            self._label_buf += data
        elif self._in_location_value and self._card is not None:
            self._card.location += data
        elif self._in_title and self._card is not None:
            self._card.title_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "span" and self._in_label:
            self._in_label = False
            if self._label_buf.strip().lower().startswith("job location"):
                self._expect_location = True
            return
        if tag == "span" and self._in_location_value:
            self._in_location_value = False
            self._expect_location = False
            return
        if tag == "h3" and self._in_title:
            self._in_title = False
            return
        if tag == "a" and self._in_anchor:
            self._in_anchor = False
            return
        if tag == "li" and self._card is not None:
            if self._card.job_id and self._card.title:
                self.cards.append(self._card)
            self._card = None


def _format_location(raw: str) -> str:
    """iCIMS location codes like 'US-CA-Marina' -> 'Marina, CA'."""
    raw = raw.strip()
    if not raw:
        return ""
    parts = raw.split("-")
    if len(parts) >= 3 and parts[0].upper() == "US":
        state = parts[1].strip()
        city = "-".join(parts[2:]).strip()
        return normalize_location(f"{city}, {state}")
    return normalize_location(raw)


class ICIMSAdapter(SourceAdapter):
    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        url = ICIMS_SEARCH.format(token=source.board_token)
        try:
            robots = await client.get_text(
                url.split("/jobs/")[0] + "/robots.txt",
                source="icims",
                company_slug=company.slug,
                follow_redirects=False,
            )
        except SourceFetchError as exc:
            if not re.match(r"HTTP (?:404|410)(?:\D|$)", exc.message):
                raise
            robots = ""
        policy = RobotsPolicy.parse(robots)
        all_postings: list[RawPosting] = []
        seen: set[str] = set()

        for page in range(MAX_PAGES):
            if not policy.can_fetch(USER_AGENT, url + f"?pr={page}&in_iframe=1"):
                raise SourceFetchError("icims", company.slug, "robots_disallowed")
            html = await client.get_text(
                url,
                source="icims",
                company_slug=company.slug,
                params={"pr": str(page), "in_iframe": "1"},
                follow_redirects=False,
            )
            parser = _JobCardParser()
            parser.feed(html)
            if not parser.cards:
                if not re.search(
                    r"iCIMS_NoResults|no (?:jobs|results|positions) (?:found|available)", html, re.I
                ):
                    raise SourceParseError(
                        "icims", company.slug, "unrecognized or incomplete search page"
                    )
                break
            new_this_page = 0
            for card in parser.cards:
                if card.job_id in seen:
                    continue
                seen.add(card.job_id)
                new_this_page += 1
                all_postings.append(self._parse_card(card, company))
            # Out-of-range pages echo the last page; stop if nothing new.
            if new_this_page == 0:
                break

        else:
            raise SourceParseError("icims", company.slug, "pagination limit reached")
        return all_postings

    def _parse_card(self, card: _Card, company: Company) -> RawPosting:
        location = _format_location(card.location)
        return RawPosting(
            source="icims",
            company_slug=company.slug,
            source_job_id=card.job_id,
            title=card.title,
            location=location,
            locations=[location] if location else [],
            url=card.url,
            posted_at=None,
            description="",
            raw_data={"job_id": card.job_id, "raw_location": card.location},
        )

    def normalize(
        self,
        raw: RawPosting,
        company: Company,
        now: str,
    ) -> Posting:
        posting_id = compute_posting_id(raw.source, raw.company_slug, raw.source_job_id)
        return Posting(
            id=posting_id,
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="icims",
            source_job_id=raw.source_job_id,
            ats="icims",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
        )
