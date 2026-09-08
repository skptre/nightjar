from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote, urljoin, urlparse

from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import is_public_hostname
from poller.models import Company, Posting, RawPosting, SourceConfig, compute_posting_id
from poller.normalize import clean_title, html_to_plaintext, normalize_location, normalize_locations
from poller.sources.base import SourceAdapter

if TYPE_CHECKING:
    from poller.http import RateLimitedClient

MAX_COMPANY_REQUESTS = 100
MAX_ROBOTS_BYTES = 512_000
MAX_XML_BYTES = 5 * 1024 * 1024
MAX_HYDRATION_NODES = 10_000
ROBOT_PRODUCT_TOKEN = "nightjar"

_JOB_PATH_MARKERS = ("/career", "/job", "/position", "/opening")
_FEED_CONTENT_TYPES = {
    "application/atom+xml",
    "application/rss+xml",
    "application/xml",
    "text/xml",
}
_COMMON_FEED_PATHS = ("/careers/feed", "/jobs/rss", "/careers.xml")
_BLOCK_MARKERS = (
    "g-recaptcha",
    "hcaptcha",
    "cf-chl-",
    "verify you are human",
    "attention required",
    "captcha challenge",
)
_HTTP_STATUS_RE = re.compile(r"\bHTTP\s+([45]\d\d)\b", re.IGNORECASE)
_REDIRECT_RE = re.compile(r"^redirect\s+3\d\d:\s+(.+)$", re.IGNORECASE)
_UNRESERVED = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


def _string(value: object | None) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _first_string(value: object | None) -> str:
    if isinstance(value, list):
        return next(
            (_first_string(item) for item in value if _first_string(item)),
            "",
        )
    if isinstance(value, dict):
        return _string(value.get("name")) or _string(value.get("value"))
    return _string(value)


def _normalize_datetime(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, OverflowError):
        return text
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _normalize_robots_octets(value: str) -> str:
    """Normalize unreserved percent escapes without decoding reserved octets."""
    output: list[str] = []
    index = 0
    while index < len(value):
        if index + 2 < len(value) and value[index] == "%":
            encoded = value[index + 1 : index + 3]
            try:
                decoded = chr(int(encoded, 16))
            except ValueError:
                output.append("%")
                index += 1
                continue
            if decoded in _UNRESERVED:
                output.append(decoded)
            else:
                output.append(f"%{encoded.upper()}")
            index += 3
            continue
        character = value[index]
        if ord(character) > 127:
            output.append(quote(character, safe=""))
        else:
            output.append(character)
        index += 1
    return "".join(output)


@dataclass(frozen=True)
class _RobotsRule:
    path: str
    allow: bool

    @property
    def specificity(self) -> int:
        return len(self.path.replace("*", "").removesuffix("$").encode())

    def matches(self, target: str) -> bool:
        anchored = self.path.endswith("$")
        pattern = self.path.removesuffix("$") if anchored else self.path
        expression = re.escape(pattern).replace(r"\*", ".*")
        if anchored:
            expression += "$"
        return re.match(f"^{expression}", target) is not None


@dataclass(frozen=True)
class _RobotsGroup:
    agents: tuple[str, ...]
    rules: tuple[_RobotsRule, ...]


@dataclass(frozen=True)
class RobotsPolicy:
    groups: tuple[_RobotsGroup, ...] = ()
    sitemaps: list[str] = field(default_factory=list)

    @classmethod
    def parse(cls, text: str) -> RobotsPolicy:
        groups: list[_RobotsGroup] = []
        sitemaps: list[str] = []
        agents: list[str] = []
        rules: list[_RobotsRule] = []

        def finish_group() -> None:
            nonlocal agents, rules
            if agents:
                groups.append(_RobotsGroup(tuple(agents), tuple(rules)))
            agents = []
            rules = []

        for raw_line in text.splitlines():
            line = raw_line.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            field_name, raw_value = line.split(":", 1)
            field_name = field_name.strip().casefold()
            value = raw_value.strip()
            if field_name == "sitemap":
                if value:
                    sitemaps.append(value)
                continue
            if field_name == "user-agent":
                if rules:
                    finish_group()
                if value:
                    agents.append(value.casefold())
                continue
            if field_name not in {"allow", "disallow"} or not agents:
                continue
            if field_name == "disallow" and not value:
                continue
            rules.append(
                _RobotsRule(
                    path=_normalize_robots_octets(value),
                    allow=field_name == "allow",
                )
            )
        finish_group()
        return cls(groups=tuple(groups), sitemaps=list(dict.fromkeys(sitemaps)))

    def can_fetch(self, product_token: str, url: str) -> bool:
        parsed = urlparse(url)
        if parsed.path == "/robots.txt":
            return True
        token = product_token.casefold()
        matching: list[tuple[int, _RobotsGroup]] = []
        for group in self.groups:
            exact = [agent for agent in group.agents if agent != "*" and agent in token]
            if exact:
                matching.append((max(len(agent) for agent in exact), group))
        if matching:
            specificity = max(item[0] for item in matching)
            selected = [group for length, group in matching if length == specificity]
        else:
            selected = [group for group in self.groups if "*" in group.agents]

        target = _normalize_robots_octets(parsed.path or "/")
        if parsed.query:
            target += f"?{_normalize_robots_octets(parsed.query)}"
        candidates = [rule for group in selected for rule in group.rules if rule.matches(target)]
        if not candidates:
            return True
        longest = max(rule.specificity for rule in candidates)
        return any(rule.allow for rule in candidates if rule.specificity == longest)


@dataclass(frozen=True)
class SitemapEntry:
    url: str
    last_modified: str | None = None


@dataclass(frozen=True)
class SitemapDocument:
    kind: Literal["index", "urlset"]
    entries: list[SitemapEntry]


def _safe_xml_root(text: str) -> ET.Element:
    payload = text.encode("utf-8")
    if len(payload) > MAX_XML_BYTES:
        raise ValueError(f"XML exceeds {MAX_XML_BYTES} byte safety limit")
    lowered = text.casefold()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise ValueError("unsafe XML declaration")
    try:
        return ET.fromstring(text)
    except ET.ParseError as exc:
        raise ValueError(f"malformed XML: {exc}") from exc


def parse_sitemap(text: str) -> SitemapDocument:
    root = _safe_xml_root(text)
    root_name = _local_name(root.tag)
    if root_name not in {"sitemapindex", "urlset"}:
        raise ValueError(f"expected sitemapindex or urlset, got {root_name!r}")
    parent_name = "sitemap" if root_name == "sitemapindex" else "url"
    entries: list[SitemapEntry] = []
    for parent in root:
        if _local_name(parent.tag) != parent_name:
            continue
        location = ""
        last_modified: str | None = None
        for child in parent:
            name = _local_name(child.tag)
            if name == "loc" and child.text:
                location = child.text.strip()
            elif name == "lastmod" and child.text:
                last_modified = child.text.strip()
        if location:
            entries.append(SitemapEntry(location, last_modified))
        else:
            raise ValueError(f"{parent_name} entry missing loc")
    kind: Literal["index", "urlset"] = "index" if root_name == "sitemapindex" else "urlset"
    return SitemapDocument(kind, entries)


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.json_ld: list[str] = []
        self.next_data: list[str] = []
        self.scripts: list[str] = []
        self.feed_links: list[str] = []
        self._script_kind: str | None = None
        self._script_chunks: list[str] = []
        self._capture_field: str | None = None
        self._capture_tag: str | None = None
        self._field_chunks: dict[str, list[str]] = {
            "title": [],
            "location": [],
            "description": [],
        }

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.casefold(): value or "" for name, value in attrs}
        lowered_tag = tag.casefold()
        if lowered_tag == "link":
            rel = set(attributes.get("rel", "").casefold().split())
            content_type = attributes.get("type", "").casefold()
            href = attributes.get("href", "").strip()
            if "alternate" in rel and content_type in _FEED_CONTENT_TYPES and href:
                self.feed_links.append(href)
        if lowered_tag == "script":
            script_type = attributes.get("type", "").casefold()
            if script_type == "application/ld+json":
                self._script_kind = "json_ld"
            elif attributes.get("id", "").casefold() == "__next_data__":
                self._script_kind = "next_data"
            else:
                self._script_kind = "script"
            self._script_chunks = []
            return

        classes = attributes.get("class", "").casefold()
        if lowered_tag in {"h1", "h2"} or "job-title" in classes:
            self._capture_field = "title"
            self._capture_tag = lowered_tag
        elif "location" in classes:
            self._capture_field = "location"
            self._capture_tag = lowered_tag
        elif "job-description" in classes or "job_description" in classes:
            self._capture_field = "description"
            self._capture_tag = lowered_tag

    def handle_endtag(self, tag: str) -> None:
        lowered_tag = tag.casefold()
        if lowered_tag == "script" and self._script_kind is not None:
            content = "".join(self._script_chunks).strip()
            if content:
                if self._script_kind == "json_ld":
                    self.json_ld.append(content)
                elif self._script_kind == "next_data":
                    self.next_data.append(content)
                else:
                    self.scripts.append(content)
            self._script_kind = None
            self._script_chunks = []
        if self._capture_tag == lowered_tag:
            self._capture_field = None
            self._capture_tag = None

    def handle_data(self, data: str) -> None:
        if self._script_kind is not None:
            self._script_chunks.append(data)
        elif self._capture_field is not None:
            self._field_chunks[self._capture_field].append(data)

    def field(self, name: str) -> str:
        return " ".join("".join(self._field_chunks[name]).split())


def _parse_html(html: str) -> _PageParser:
    parser = _PageParser()
    parser.feed(html)
    parser.close()
    return parser


def _walk_json(value: object) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    stack: list[object] = [value]
    visited = 0
    while stack and visited < MAX_HYDRATION_NODES:
        current = stack.pop()
        visited += 1
        if isinstance(current, dict):
            found.append(current)
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return found


def _is_job_posting(value: dict[str, Any]) -> bool:
    schema_type = value.get("@type")
    if isinstance(schema_type, str):
        return schema_type.casefold() == "jobposting"
    if isinstance(schema_type, list):
        return any(_string(item).casefold() == "jobposting" for item in schema_type)
    return False


def _location_name(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, dict):
        return ""
    address = value.get("address", value)
    if isinstance(address, str):
        return address.strip()
    if not isinstance(address, dict):
        return _string(value.get("name"))
    parts = [
        _string(address.get("addressLocality")),
        _string(address.get("addressRegion")),
        _first_string(address.get("addressCountry")),
    ]
    return ", ".join(part for part in parts if part) or _string(value.get("name"))


def _extract_locations(value: object, remote: bool = False) -> list[str]:
    raw_values = value if isinstance(value, list) else [value]
    locations = [_location_name(item) for item in raw_values]
    result = [location for location in locations if location]
    if remote and "Remote" not in result:
        result.append("Remote")
    return result


def _identifier(value: object) -> str:
    if isinstance(value, dict):
        return _string(value.get("value")) or _string(value.get("name"))
    return _string(value)


def _format_salary(value: object) -> str | None:
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return _string(value) or None
    if not isinstance(value, dict):
        return None
    currency = _string(value.get("currency"))
    amount = value.get("value")
    unit = ""
    rendered = ""
    if isinstance(amount, dict):
        minimum = _string(amount.get("minValue"))
        maximum = _string(amount.get("maxValue"))
        exact = _string(amount.get("value"))
        unit = _string(amount.get("unitText"))
        rendered = f"{minimum}-{maximum}" if minimum and maximum else minimum or maximum or exact
    else:
        rendered = _string(amount)
    if not rendered:
        return None
    return " ".join(part for part in (currency, rendered, f"per {unit}" if unit else "") if part)


def _json_ld_posting(
    value: dict[str, Any], company_slug: str, page_url: str, *, include_sections: bool = False,
) -> RawPosting | None:
    title = _string(value.get("title")) or _string(value.get("name"))
    url = _string(value.get("url")) or page_url
    explicit_identifier = _identifier(value.get("identifier"))
    source_job_id = explicit_identifier or url
    if not title or not source_job_id or not url:
        return None
    remote = _string(value.get("jobLocationType")).casefold() == "telecommute"
    locations = _extract_locations(value.get("jobLocation"), remote)
    employment = value.get("employmentType")
    employment_type: str | None
    if isinstance(employment, list):
        employment_type = ", ".join(_string(item) for item in employment if _string(item))
    else:
        employment_type = _string(employment) or None
    organization = value.get("hiringOrganization")
    organization_name = _first_string(organization)
    applicant_location = _first_string(value.get("applicantLocationRequirements"))
    metadata: dict[str, Any] = {
        "extraction_method": "json_ld",
        "hiring_organization": organization_name,
        "direct_apply": value.get("directApply"),
        "applicant_location_requirements": applicant_location,
    }
    description = html_to_plaintext(_string(value.get("description")))
    if include_sections and description:
        for name, label in (
            ("responsibilities", "Responsibilities"), ("qualifications", "Qualifications"),
            ("educationRequirements", "Education and Experience"),
            ("experienceRequirements", "Required Experience"), ("skills", "Skills"),
            ("jobBenefits", "Benefits"),
        ):
            content = value.get(name)
            items = content if isinstance(content, list) else [content]
            for item in items:
                text = html_to_plaintext(item) if isinstance(item, str) else ""
                if text and " ".join(text.split()) not in " ".join(description.split()):
                    description += f"\n\n{label}\n\n{text}"
    return RawPosting(
        source="generic",
        company_slug=company_slug,
        source_job_id=source_job_id,
        title=title,
        location=locations[0] if locations else "",
        locations=locations,
        url=urljoin(page_url, url),
        posted_at=_string(value.get("datePosted")) or None,
        description=description.strip(),
        raw_data={key: item for key, item in metadata.items() if item not in {None, ""}},
        compensation=_format_salary(value.get("baseSalary")),
        employment_type=employment_type,
        requisition_id=explicit_identifier or None,
        workplace_type="Remote" if remote else None,
        valid_through=_string(value.get("validThrough")) or None,
        education_requirements=_first_string(value.get("educationRequirements")) or None,
        experience_requirements=_first_string(value.get("experienceRequirements")) or None,
        occupational_category=_first_string(value.get("occupationalCategory")) or None,
    )


def extract_json_ld(
    html: str, company_slug: str, page_url: str, *, deduplicate: bool = True,
    include_sections: bool = False,
) -> list[RawPosting]:
    parser = _parse_html(html)
    postings: list[RawPosting] = []
    for block in parser.json_ld:
        try:
            value: object = json.loads(block)
        except json.JSONDecodeError:
            continue
        for candidate in _walk_json(value):
            if not _is_job_posting(candidate):
                continue
            posting = _json_ld_posting(candidate, company_slug, page_url,
                                       include_sections=include_sections)
            if posting is not None:
                postings.append(posting)
    return _dedupe_raw(postings) if deduplicate else postings


def _balanced_json_after(script: str, marker: str) -> object | None:
    marker_index = script.find(marker)
    if marker_index < 0:
        return None
    equals_index = script.find("=", marker_index + len(marker))
    if equals_index < 0:
        return None
    remainder = script[equals_index + 1 :].lstrip()
    if not remainder or remainder[0] not in "[{":
        return None
    try:
        value: object
        value, _ = json.JSONDecoder().raw_decode(remainder)
    except json.JSONDecodeError:
        return None
    return value


def _hydration_location(value: object) -> str:
    if isinstance(value, dict):
        parts = [
            _string(value.get("city")),
            _string(value.get("state")) or _string(value.get("region")),
            _first_string(value.get("country")),
        ]
        return ", ".join(part for part in parts if part) or _string(value.get("name"))
    return _string(value)


def _hydration_posting(
    value: dict[str, Any], company_slug: str, page_url: str
) -> RawPosting | None:
    title = _string(value.get("title")) or _string(value.get("name"))
    source_job_id = next(
        (
            _string(value.get(key))
            for key in ("id", "jobId", "job_id", "requisitionId", "requisition_id")
            if _string(value.get(key))
        ),
        "",
    )
    raw_url = next(
        (
            _string(value.get(key))
            for key in ("url", "applyUrl", "jobUrl", "absoluteUrl")
            if _string(value.get(key))
        ),
        "",
    )
    if not title or not source_job_id or not raw_url:
        return None
    url = urljoin(page_url, raw_url)
    if not any(marker in urlparse(url).path.casefold() for marker in _JOB_PATH_MARKERS):
        return None
    location = _hydration_location(value.get("location"))
    return RawPosting(
        source="generic",
        company_slug=company_slug,
        source_job_id=source_job_id,
        title=title,
        location=location,
        locations=[location] if location else [],
        url=url,
        posted_at=_string(value.get("datePosted")) or _string(value.get("postedAt")) or None,
        description=html_to_plaintext(_string(value.get("description"))),
        raw_data={"extraction_method": "hydration"},
        employment_type=_string(value.get("employmentType")) or None,
        requisition_id=source_job_id,
    )


def extract_hydration(html: str, company_slug: str, page_url: str) -> list[RawPosting]:
    parser = _parse_html(html)
    roots: list[object] = []
    for block in parser.next_data:
        try:
            roots.append(json.loads(block))
        except json.JSONDecodeError:
            continue
    for script in parser.scripts:
        initial_state = _balanced_json_after(script, "window.__INITIAL_STATE__")
        if initial_state is not None:
            roots.append(initial_state)
    postings: list[RawPosting] = []
    for root in roots:
        for candidate in _walk_json(root):
            posting = _hydration_posting(candidate, company_slug, page_url)
            if posting is not None:
                postings.append(posting)
    return _dedupe_raw(postings)


@dataclass(frozen=True)
class QuarantinedPosting:
    company_slug: str
    title: str
    location: str
    url: str
    description: str
    extraction_method: Literal["html_heuristic"] = "html_heuristic"
    extraction_confidence: Literal["low"] = "low"
    review_required: Literal[True] = True


def extract_html_heuristic(html: str, company_slug: str, page_url: str) -> list[QuarantinedPosting]:
    if not any(marker in urlparse(page_url).path.casefold() for marker in _JOB_PATH_MARKERS):
        return []
    parser = _parse_html(html)
    title = parser.field("title")
    description = parser.field("description")
    if not title or not description:
        return []
    return [
        QuarantinedPosting(
            company_slug=company_slug,
            title=title,
            location=parser.field("location"),
            url=page_url,
            description=description,
        )
    ]


def parse_feed(text: str, company_slug: str, base_url: str) -> list[RawPosting]:
    root = _safe_xml_root(text)
    root_name = _local_name(root.tag)
    postings: list[RawPosting] = []
    if root_name == "rss":
        items = [element for element in root.iter() if _local_name(element.tag) == "item"]
        for item in items:
            values: dict[str, str] = {}
            for child in item:
                name = _local_name(child.tag)
                if child.text and name in {"guid", "title", "link", "pubdate", "description"}:
                    values[name] = child.text.strip()
            title = values.get("title", "")
            link = values.get("link", "")
            source_job_id = values.get("guid", "") or link
            if not title or not link or not source_job_id:
                raise ValueError("malformed RSS item: title, link, and stable ID required")
            postings.append(
                RawPosting(
                    source="generic",
                    company_slug=company_slug,
                    source_job_id=source_job_id,
                    title=title,
                    location="",
                    locations=[],
                    url=urljoin(base_url, link),
                    posted_at=_normalize_datetime(values.get("pubdate", "")) or None,
                    description=html_to_plaintext(values.get("description", "")),
                    raw_data={"extraction_method": "rss"},
                )
            )
    elif root_name == "feed":
        entries = [element for element in root if _local_name(element.tag) == "entry"]
        for entry in entries:
            title = ""
            identifier = ""
            updated = ""
            description = ""
            link = ""
            for child in entry:
                name = _local_name(child.tag)
                content = (child.text or "").strip()
                if name == "title":
                    title = content
                elif name == "id":
                    identifier = content
                elif name in {"updated", "published"} and not updated:
                    updated = content
                elif name in {"summary", "content"} and not description:
                    description = content
                elif name == "link" and not link:
                    rel = child.attrib.get("rel", "alternate").casefold()
                    if rel == "alternate":
                        link = child.attrib.get("href", "").strip()
            if not title or not identifier or not link:
                raise ValueError("malformed Atom entry: title, link, and id required")
            postings.append(
                RawPosting(
                    source="generic",
                    company_slug=company_slug,
                    source_job_id=identifier,
                    title=title,
                    location="",
                    locations=[],
                    url=urljoin(base_url, link),
                    posted_at=_normalize_datetime(updated) or None,
                    description=html_to_plaintext(description),
                    raw_data={"extraction_method": "rss"},
                )
            )
    else:
        raise ValueError(f"expected RSS or Atom feed, got {root_name!r}")
    return _dedupe_raw(postings)


def _dedupe_raw(postings: list[RawPosting]) -> list[RawPosting]:
    unique: dict[str, RawPosting] = {}
    for posting in postings:
        unique.setdefault(posting.source_job_id, posting)
    return list(unique.values())


def _looks_like_job_url(url: str) -> bool:
    return any(marker in urlparse(url).path.casefold() for marker in _JOB_PATH_MARKERS)


def _is_block_page(text: str) -> bool:
    lowered = text.casefold()
    return any(marker in lowered for marker in _BLOCK_MARKERS)


def _http_status(error: SourceFetchError) -> int | None:
    match = _HTTP_STATUS_RE.search(error.message)
    return int(match.group(1)) if match else None


class GenericAdapter(SourceAdapter):
    def __init__(self) -> None:
        self.extraction_status: Literal["supported", "blocked", "unsupported"] = "unsupported"
        self.quarantined_results: list[QuarantinedPosting] = []
        self._request_count = 0
        self._policy = RobotsPolicy()
        self._origin = ""

    @staticmethod
    def normalize_board_url(board_token: str) -> str:
        candidate = board_token.strip()
        if "://" not in candidate:
            candidate = f"https://{candidate}"
        parsed = urlparse(candidate)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.username
            or parsed.password
            or not parsed.hostname
            or not is_public_hostname(parsed.hostname)
        ):
            raise ValueError("generic board_token must be a public HTTP(S) URL")
        path = parsed.path.rstrip("/") or "/"
        return parsed._replace(path=path, fragment="").geturl().rstrip("/")

    def _same_host(self, url: str) -> bool:
        return urlparse(url).hostname == urlparse(self._origin).hostname

    async def _get_text(
        self,
        client: RateLimitedClient,
        url: str,
        company: Company,
        *,
        enforce_robots: bool = True,
    ) -> str:
        current_url = url
        for redirect_count in range(6):
            if self._request_count >= MAX_COMPANY_REQUESTS:
                raise SourceFetchError("generic", company.slug, "company request limit reached")
            if not self._same_host(current_url):
                raise SourceFetchError("generic", company.slug, "cross-host request refused")
            if enforce_robots and not self._policy.can_fetch(ROBOT_PRODUCT_TOKEN, current_url):
                self.extraction_status = "blocked"
                raise SourceFetchError(
                    "generic", company.slug, f"blocked by robots.txt: {current_url}"
                )
            self._request_count += 1
            try:
                text = await client.get_text(
                    current_url,
                    source="generic",
                    company_slug=company.slug,
                    follow_redirects=False,
                )
            except SourceFetchError as exc:
                redirect = _REDIRECT_RE.match(exc.message)
                if redirect is None:
                    raise
                if redirect_count >= 5:
                    raise SourceFetchError(
                        "generic", company.slug, "redirect limit exceeded (5)"
                    ) from exc
                current_url = urljoin(current_url, redirect.group(1).strip())
                continue
            if _is_block_page(text):
                self.extraction_status = "blocked"
                raise SourceFetchError(
                    "generic", company.slug, f"anti-bot challenge at {current_url}"
                )
            return text
        raise SourceFetchError(  # pragma: no cover - loop returns or raises
            "generic", company.slug, "redirect handling exhausted"
        )

    async def _optional_text(
        self, client: RateLimitedClient, url: str, company: Company
    ) -> str | None:
        try:
            return await self._get_text(client, url, company)
        except SourceFetchError as exc:
            status = _http_status(exc)
            if status is not None and 400 <= status < 500:
                return None
            raise

    async def _load_robots(self, client: RateLimitedClient, company: Company) -> RobotsPolicy:
        robots_url = f"{self._origin}/robots.txt"
        try:
            text = await self._get_text(client, robots_url, company, enforce_robots=False)
        except SourceFetchError as exc:
            status = _http_status(exc)
            if status is not None and 400 <= status < 500:
                return RobotsPolicy()
            self.extraction_status = "blocked"
            raise SourceFetchError(
                "generic", company.slug, f"robots.txt unreachable; access disallowed: {exc.message}"
            ) from exc
        encoded = text.encode("utf-8")
        if len(encoded) > MAX_ROBOTS_BYTES:
            text = encoded[:MAX_ROBOTS_BYTES].decode("utf-8", errors="ignore")
        return RobotsPolicy.parse(text)

    async def _sitemap_job_urls(
        self,
        client: RateLimitedClient,
        company: Company,
        sitemap_urls: list[str],
        base_url: str,
    ) -> tuple[list[SitemapEntry], bool, list[RawPosting], bool]:
        jobs: list[SitemapEntry] = []
        structured_success = False
        feed_postings: list[RawPosting] = []
        saw_valid_feed = False
        queue = list(dict.fromkeys(sitemap_urls))
        seen: set[str] = set()
        while queue and self._request_count < MAX_COMPANY_REQUESTS:
            url = queue.pop(0)
            if url in seen or not self._same_host(url):
                continue
            seen.add(url)
            text = await self._optional_text(client, url, company)
            if text is None:
                continue
            try:
                document = parse_sitemap(text)
            except ValueError as exc:
                try:
                    parsed_feed = parse_feed(text, company.slug, base_url)
                except ValueError:
                    raise SourceParseError(
                        "generic", company.slug, f"invalid sitemap or feed {url}: {exc}"
                    ) from exc
                saw_valid_feed = True
                feed_postings.extend(parsed_feed)
                continue
            if document.kind == "index":
                queue.extend(
                    entry.url
                    for entry in document.entries
                    if self._same_host(entry.url) and _looks_like_job_url(entry.url)
                )
                continue
            if _looks_like_job_url(url):
                structured_success = True
            jobs.extend(
                entry
                for entry in document.entries
                if self._same_host(entry.url) and _looks_like_job_url(entry.url)
            )
        unique = {entry.url: entry for entry in jobs}
        return (
            list(unique.values()),
            structured_success,
            _dedupe_raw(feed_postings),
            saw_valid_feed,
        )

    async def fetch(
        self,
        client: RateLimitedClient,
        company: Company,
        source: SourceConfig,
    ) -> list[RawPosting]:
        self.extraction_status = "unsupported"
        self.quarantined_results = []
        self._request_count = 0
        try:
            base_url = self.normalize_board_url(source.board_token)
        except ValueError as exc:
            raise SourceFetchError("generic", company.slug, str(exc)) from exc
        parsed_base = urlparse(base_url)
        self._origin = f"{parsed_base.scheme}://{parsed_base.netloc}"
        self._policy = await self._load_robots(client, company)
        base_scope = f"{base_url}/" if not base_url.endswith("/") else base_url
        if not self._policy.can_fetch(ROBOT_PRODUCT_TOKEN, base_url) or not self._policy.can_fetch(
            ROBOT_PRODUCT_TOKEN, base_scope
        ):
            self.extraction_status = "blocked"
            raise SourceFetchError("generic", company.slug, f"blocked by robots.txt: {base_url}")

        base_html = await self._get_text(client, base_url, company)
        parser = _parse_html(base_html)

        sitemap_urls = [
            urljoin(self._origin, url)
            for url in self._policy.sitemaps
            if self._same_host(urljoin(self._origin, url))
        ]
        if not sitemap_urls:
            sitemap_urls = [f"{self._origin}/sitemap.xml"]
        (
            job_pages,
            sitemap_empty_is_authoritative,
            robots_feed_postings,
            saw_valid_feed,
        ) = await self._sitemap_job_urls(client, company, sitemap_urls, base_url)

        base_postings = extract_json_ld(base_html, company.slug, base_url)
        if not base_postings:
            base_postings = extract_hydration(base_html, company.slug, base_url)

        feed_urls = [urljoin(base_url, href) for href in parser.feed_links]
        if not feed_urls and not job_pages and not base_postings and not robots_feed_postings:
            feed_urls = [f"{self._origin}{path}" for path in _COMMON_FEED_PATHS]
        feed_postings = list(robots_feed_postings)
        for feed_url in dict.fromkeys(feed_urls):
            if self._request_count >= MAX_COMPANY_REQUESTS or not self._same_host(feed_url):
                continue
            text = await self._optional_text(client, feed_url, company)
            if text is None:
                continue
            try:
                parsed_feed = parse_feed(text, company.slug, base_url)
            except ValueError as exc:
                if feed_url in [urljoin(base_url, href) for href in parser.feed_links]:
                    raise SourceParseError(
                        "generic", company.slug, f"invalid discovered feed {feed_url}: {exc}"
                    ) from exc
                continue
            saw_valid_feed = True
            feed_postings.extend(parsed_feed)
        if feed_postings:
            self.extraction_status = "supported"
            return _dedupe_raw(feed_postings + base_postings)

        page_postings = list(base_postings)
        for entry in job_pages:
            if self._request_count >= MAX_COMPANY_REQUESTS:
                break
            page_html = await self._optional_text(client, entry.url, company)
            if page_html is None:
                continue
            extracted = extract_json_ld(page_html, company.slug, entry.url)
            if not extracted:
                extracted = extract_hydration(page_html, company.slug, entry.url)
            if extracted:
                for posting in extracted:
                    posting.raw_data["discovery_method"] = "sitemap"
                    if entry.last_modified:
                        posting.raw_data["sitemap_lastmod"] = entry.last_modified
                page_postings.extend(extracted)
            else:
                self.quarantined_results.extend(
                    extract_html_heuristic(page_html, company.slug, entry.url)
                )

        if page_postings:
            self.extraction_status = "supported"
            return _dedupe_raw(page_postings)

        self.quarantined_results.extend(extract_html_heuristic(base_html, company.slug, base_url))
        if self.quarantined_results:
            raise SourceFetchError(
                "generic",
                company.slug,
                "unsupported: only low-confidence HTML heuristic results; quarantined",
            )
        if saw_valid_feed or sitemap_empty_is_authoritative:
            self.extraction_status = "supported"
            return []
        raise SourceFetchError(
            "generic", company.slug, "unsupported: no structured extraction strategy matched"
        )

    def normalize(self, raw: RawPosting, company: Company, now: str) -> Posting:
        metadata = dict(raw.raw_data)
        optional_metadata: dict[str, str | None] = {
            "requisition_id": raw.requisition_id,
            "updated_at": raw.updated_at,
            "education_requirements": raw.education_requirements,
            "experience_requirements": raw.experience_requirements,
            "occupational_category": raw.occupational_category,
        }
        metadata.update(
            {key: value for key, value in optional_metadata.items() if value is not None}
        )
        metadata.setdefault("extraction_method", "unknown")
        metadata["extraction_confidence"] = "high"
        metadata["review_required"] = False
        return Posting(
            id=compute_posting_id(raw.source, raw.company_slug, raw.source_job_id),
            company=company.name,
            company_slug=company.slug,
            title=clean_title(raw.title),
            location=normalize_location(raw.location),
            locations=normalize_locations(raw.locations),
            url=raw.url,
            source="generic",
            source_job_id=raw.source_job_id,
            ats="generic",
            posted_at=raw.posted_at,
            first_seen_at=now,
            last_seen_at=now,
            description_text=raw.description,
            compensation=raw.compensation,
            employment_type=raw.employment_type,
            department=raw.department,
            workplace_type=raw.workplace_type,
            valid_through=raw.valid_through,
            source_metadata=metadata,
        )
