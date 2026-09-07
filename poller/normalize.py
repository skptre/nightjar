from __future__ import annotations

import html
import re
from html.parser import HTMLParser

_DASH_CHARS = re.compile(
    "[‐‑‒–—―﹘﹣－]"
)

_HTML_TAG = re.compile(r"<[^>]+>")

_MULTI_WS = re.compile(r"\s+")

_LOCATION_SPLITTERS = re.compile(r"(?:\s+or)+\s+|\s*/\s*|\s*;\s*", re.IGNORECASE)

_LOCATION_ALIASES: dict[str, str] = {
    "nyc": "New York, NY",
    "new york city": "New York, NY",
    "sf": "San Francisco, CA",
    "san francisco": "San Francisco, CA",
    "la": "Los Angeles, CA",
    "los angeles": "Los Angeles, CA",
    "dc": "Washington, DC",
    "washington d.c.": "Washington, DC",
    "washington, d.c.": "Washington, DC",
}

_REMOTE_SYNONYMS = frozenset({"remote", "anywhere", "work from anywhere", "worldwide"})

def clean_title(title: str | None) -> str:
    if not title:
        return ""
    text = _DASH_CHARS.sub("-", title)
    text = _MULTI_WS.sub(" ", text)
    return text.strip()


def normalize_location(location: str | None) -> str:
    if not location:
        return ""
    text = location.strip()
    if not text:
        return ""
    lower = text.lower()
    if lower in _REMOTE_SYNONYMS:
        return "Remote"
    return _LOCATION_ALIASES.get(lower, text)


def split_locations(raw: str | None) -> list[str]:
    if not raw:
        return []
    collapsed = _MULTI_WS.sub(" ", raw).strip()
    parts = _LOCATION_SPLITTERS.split(collapsed)
    result: list[str] = []
    for part in parts:
        normalized = normalize_location(part)
        if normalized:
            result.append(normalized)
    return result


def normalize_locations(locations: list[str] | None) -> list[str]:
    if not locations:
        return []
    return [normalize_location(loc) for loc in locations if normalize_location(loc)]


def unescape_html(text: str) -> str:
    previous = ""
    current = text
    for _ in range(5):
        previous = current
        current = html.unescape(current)
        if current == previous:
            break
    return current


def strip_tags(text: str) -> str:
    stripped = _HTML_TAG.sub(" ", text)
    collapsed = _MULTI_WS.sub(" ", stripped)
    return collapsed.strip()


class _DescriptionParser(HTMLParser):
    """Keep document boundaries and inline wording; never emit executable markup."""

    _BLOCKS = frozenset({
        "p", "div", "section", "article", "header", "footer", "blockquote",
        "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "dt", "dd", "table",
    })
    _IGNORE = frozenset({"script", "style", "noscript", "template", "head"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.ignored: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._IGNORE:
            self.ignored.append(tag)
        if self.ignored:
            return
        if tag in self._BLOCKS:
            self.parts.append("\n\n")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in {"br", "hr", "tr"}:
            self.parts.append("\n")
        elif tag in {"td", "th"}:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if self.ignored:
            if tag == self.ignored[-1]:
                self.ignored.pop()
            return
        if tag in self._BLOCKS:
            self.parts.append("\n\n")
        elif tag == "tr":
            self.parts.append("\n")
        elif tag in {"td", "th"}:
            self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        if not self.ignored:
            self.parts.append(data)


def html_to_plaintext(raw_html: str | None) -> str:
    """Normalize complete description text; presentation limits belong in the app.

    Preserve paragraph/list boundaries for evidence extraction. This is plaintext,
    not sanitized HTML: consumers must render it as text, never inject it as markup.
    """
    if not raw_html:
        return ""
    parser = _DescriptionParser()
    parser.feed(unescape_html(raw_html))
    parser.close()
    lines = [re.sub(r"[^\S\n]+", " ", line).strip()
             for line in "".join(parser.parts).replace("\r\n", "\n").split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    # Rich-text editors wrap the first sentence inside <li><p> or <li><div>.
    # Keep its marker attached while retaining subsequent paragraphs and nested lists.
    return re.sub(r"(?m)^-[ \t]*\n+(?=[^\s-])", "- ", text)


def safe_string(value: object | None, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def safe_list(value: list[str] | None) -> list[str]:
    if value is None:
        return []
    return list(value)
