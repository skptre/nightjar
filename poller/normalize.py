from __future__ import annotations

import html
import re

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

PLAINTEXT_CAP = 5000


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


def html_to_plaintext(raw_html: str | None) -> str:
    if not raw_html:
        return ""
    unescaped = unescape_html(raw_html)
    plaintext = strip_tags(unescaped)
    if len(plaintext) > PLAINTEXT_CAP:
        plaintext = plaintext[:PLAINTEXT_CAP]
    return plaintext


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
