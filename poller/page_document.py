"""Matched job documents, with conservative completeness for unfamiliar HTML.

Generic extraction is useful evidence, not proof that every employer clause was
captured. Only matched structured JobPosting contracts certify completeness.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from html import escape
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urljoin, urlparse

from poller.normalize import html_to_plaintext
from poller.sources.generic import extract_hydration, extract_json_ld

_IGNORE = {"script", "style", "noscript", "template", "nav", "footer", "aside", "form"}
_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
         "param", "source", "track", "wbr"}
_TRACKING = {"source", "ref", "referrer", "gh_src", "lever-source", "lever-origin",
             "fbclid", "gclid", "trackingid"}
_CONTAINER = re.compile(r"(?:^|[\s_-])(?:job[\s_-]?description|job[\s_-]?details|"
                        r"job[\s_-]?detail[\s_-]?body|description[\s_-]?content)(?:$|[\s_-])", re.I)


def normalized_title(value: str) -> str:
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", value).casefold()))


def same_job_url(left: str, right: str) -> bool:
    """Ignore known tracking only; query parameters can identify different jobs."""
    def key(value: str) -> tuple[str, str, list[tuple[str, str]]]:
        parsed = urlparse(value)
        query = sorted((k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
                       if not k.lower().startswith("utm_") and k.lower() not in _TRACKING)
        return (parsed.netloc.casefold(), parsed.path.rstrip("/") or "/", query)
    return key(left) == key(right)


@dataclass
class _Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list[_Node | str] = field(default_factory=list)

    def walk(self) -> list[_Node]:
        result = [self]
        for child in self.children:
            if isinstance(child, _Node):
                result.extend(child.walk())
        return result

    def html(self) -> str:
        if self.tag in _IGNORE or "hidden" in self.attrs or self.attrs.get("aria-hidden") == "true":
            return ""
        body = "".join(child.html() if isinstance(child, _Node) else escape(child)
                       for child in self.children)
        return f"<{self.tag}>{body}</{self.tag}>"

    def text(self) -> str:
        return html_to_plaintext(self.html())


class _Document(HTMLParser):
    def __init__(self, html: str) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("document")
        self.stack = [self.root]
        self.node_count = 0
        self.feed(html)
        self.close()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.node_count += 1
        if self.node_count > 30_000 or len(self.stack) > 150:
            raise ValueError("description_page_complexity_limit")
        node = _Node(tag, {k: v or "" for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


@dataclass(frozen=True)
class JobDocument:
    text: str
    status: str
    method: str
    compensation: str | None = None


def _unique(documents: list[JobDocument]) -> JobDocument | None:
    unique = {" ".join(item.text.split()): item for item in documents if item.text.strip()}
    if len(unique) > 1:
        raise ValueError("ambiguous_matching_jobposting")
    return next(iter(unique.values()), None)


def extract_document(html: str, url: str, title: str) -> JobDocument:
    if len(html.encode("utf-8")) > 2_000_000:
        raise ValueError("invalid_or_oversized_description_page")
    tree = _Document(html)
    nodes = tree.root.walk()
    expected = normalized_title(title)
    blocks = ["".join(c for c in node.children if isinstance(c, str)) for node in nodes
              if node.tag == "script" and node.attrs.get("type", "").lower()
              == "application/ld+json"]
    structured = [JobDocument(p.description, "available", "json_ld", p.compensation)
                  for block in blocks
                  for p in extract_json_ld(
                      '<script type="application/ld+json">' + block + '</script>', "document", url,
                      deduplicate=False, include_sections=True)
                  if same_job_url(p.url, url) and normalized_title(p.title) == expected]

    for root in nodes:
        if not any(t.rstrip("/").endswith("/JobPosting")
                   for t in root.attrs.get("itemtype", "").split()):
            continue
        fields: dict[str, list[str]] = {}
        # Nested scopes (e.g. hiringOrganization) must not supply the job title.
        def visit(node: _Node, scope: _Node, values: dict[str, list[str]]) -> None:
            if node is not scope and "itemscope" in node.attrs:
                return
            for prop in node.attrs.get("itemprop", "").split():
                value = node.attrs.get("content") or node.attrs.get("href") or node.text()
                values.setdefault(prop, []).append(value)
            for child in node.children:
                if isinstance(child, _Node):
                    visit(child, scope, values)
        visit(root, root, fields)
        if len(fields.get("title", [])) != 1 or normalized_title(fields["title"][0]) != expected:
            continue
        if any(not same_job_url(urljoin(url, value), url) for value in fields.get("url", [])):
            continue
        if not fields.get("description"):
            continue
        parts = list(fields["description"])
        for name in ("responsibilities", "qualifications", "educationRequirements",
                     "experienceRequirements", "skills", "jobBenefits", "baseSalary"):
            for value in fields.get(name, []):
                if value and not any(value in part for part in parts):
                    parts.append(f"{name}\n\n{value}")
        structured.append(JobDocument("\n\n".join(parts), "available", "microdata"))
    document = _unique(structured)

    matching_title = any(node.tag == "h1" and normalized_title(node.text()) == expected
                         for node in nodes)
    # Multiple job headings indicate a listing page, not one isolated description.
    headings = {normalized_title(node.text()) for node in nodes if node.tag == "h1"}
    containers = [node for node in nodes if _CONTAINER.search(
        node.attrs.get("class", "") + " " + node.attrs.get("id", ""))]
    # Retain outer containers rather than duplicating their child sections.
    containers = [node for node in containers if not any(
        other is not node and any(child is node for child in other.walk()[1:])
        for other in containers)]
    visible: JobDocument | None = None
    if matching_title and headings == {expected}:
        if not containers:
            containers = [node for node in nodes if node.tag == "main"]
        texts = [node.text() for node in containers]
        texts = [text for text in texts if text and normalized_title(text) != expected]
        if len(texts) == 1:
            visible = JobDocument(texts[0], "partial", "html_container")
    if document:
        if visible:
            source = " ".join(document.text.split()).casefold()
            # Compare paragraphs, excluding the page title. More visible material
            # invalidates a completeness claim; generic HTML never becomes certified.
            extra = [part for part in visible.text.split("\n\n")
                     if normalized_title(part) != expected
                     and " ".join(part.split()).casefold() not in source]
            if extra and source in " ".join(visible.text.split()).casefold():
                return JobDocument(visible.text, "partial", "html_container", document.compensation)
        return document
    if visible:
        return visible
    hydration = [JobDocument(p.description, "partial", "hydration")
                 for p in extract_hydration(html, "document", url)
                 if same_job_url(p.url, url) and normalized_title(p.title) == expected]
    document = _unique(hydration)
    if document:
        return document
    raise ValueError("no_unique_matching_jobposting")
