"""Read observed first-party page data without executing JavaScript or crawling assets."""

from __future__ import annotations

import json
import re
from html import escape
from typing import Any
from urllib.parse import urlparse

from poller.normalize import html_to_plaintext


def _flight_records(scripts: list[str]) -> dict[str, Any]:
    chunks = []
    for script in scripts:
        match = re.fullmatch(r"\s*self\.__next_f\.push\((.*)\)\s*;?\s*", script, re.S)
        if not match:
            continue
        try:
            data = json.loads(match[1])
        except ValueError:
            continue
        if isinstance(data, list) and len(data) == 2 and data[0] == 1 and isinstance(data[1], str):
            chunks.append(data[1])
    data = "".join(chunks).encode("utf-8")
    records: dict[str, Any] = {}
    index = 0
    while index < len(data):
        byte_match = re.match(rb"([0-9a-f]+):", data[index:])
        if not byte_match:
            raise ValueError("invalid_streamed_description")
        key = byte_match[1].decode()
        index += byte_match.end()
        text = re.match(rb"T([0-9a-f]+),", data[index:])
        if text:
            index += text.end()
            length = int(text[1], 16)
            if index + length > len(data):
                raise ValueError("truncated_streamed_description")
            value: Any = data[index : index + length].decode("utf-8")
            index += length
        else:
            end = data.find(b"\n", index)
            if end < 0:
                end = len(data)
            try:
                value = json.loads(data[index:end])
            except ValueError:
                value = None  # Module import/hint records are not job content.
            index = end + 1
        if key in records:
            raise ValueError("ambiguous_streamed_description")
        records[key] = value
    return records


def _walk(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        return [value] + [item for child in value.values() for item in _walk(child)]
    if isinstance(value, list):
        return [item for child in value for item in _walk(child)]
    return []


def _render(value: Any, records: dict[str, Any], trail: frozenset[str] = frozenset()) -> str:
    if isinstance(value, str):
        # Opaque client components (apply controls/recommendations) are not text.
        # Their omission is why this recovery is partial, never certified complete.
        if re.fullmatch(r"\$L[0-9a-f]+", value):
            return ""
        if value == "$undefined":
            return ""
        if value.startswith("$$"):
            return escape(value[1:])
        if re.fullmatch(r"\$[0-9a-f]+", value):
            key = value[1:]
            if key not in records or key in trail:
                raise ValueError("unresolved_description_reference")
            return _render(records[key], records, trail | {key})
        if value.startswith("$"):
            raise ValueError("unsupported_description_reference")
        return escape(value)
    if isinstance(value, list):
        if len(value) == 4 and value[0] == "$" and isinstance(value[3], dict):
            tag, props = value[1], value[3]
            if tag in {"button", "svg", "script", "style", "input"}:
                return ""
            raw = props.get("dangerouslySetInnerHTML", {}).get("__html")
            if isinstance(raw, str):
                if re.fullmatch(r"\$[0-9a-f]+", raw):
                    key = raw[1:]
                    if key not in records or not isinstance(records[key], str):
                        raise ValueError("unresolved_description_reference")
                    raw = str(records[key])
                return "<div>" + raw + "</div>"
            children = _render(props.get("children"), records, trail)
            return (
                "<div>" + children + "</div>"
                if tag in {"div", "p", "section", "h1", "h2", "h3", "li"}
                else children
            )
        return "".join(_render(child, records, trail) for child in value)
    return ""


def extract_page_data(scripts: list[str], url: str, title: str) -> list[tuple[str, str]]:
    # Local import avoids a module cycle; the document validator owns title/URL rules.
    from poller.page_document import normalized_title, same_job_url, title_is_shortening

    parsed = urlparse(url)
    results = []
    if parsed.hostname in {"ats.rippling.com", "ats.us1.rippling.com", "ats.eu1.rippling.com"}:
        path = re.fullmatch(r"/([^/]+)/jobs/([a-zA-Z0-9-]+)/?", parsed.path)
        if not path:
            return []
        for script in scripts:
            try:
                data = json.loads(script)
                api = data["props"]["pageProps"]["apiData"]
                job, board = api["jobPost"], api["jobBoard"]
                if (
                    job["uuid"] != path[2]
                    or board["slug"] != path[1]
                    or not same_job_url(job["url"], url)
                    or not title_is_shortening(normalized_title(title), job["name"])
                ):
                    continue
                description = job["description"]
                if not isinstance(description, dict) or not description.get("role"):
                    continue
                parts = [value for value in description.values() if isinstance(value, str)]
                parts.append(board.get("legalNotice") or "")
                pay = api.get("payRangeDetails")
                if pay:
                    parts.append(
                        "<h2>Advertised compensation</h2><p>" + escape(json.dumps(pay)) + "</p>"
                    )
                results.append((html_to_plaintext("\n".join(parts)), "rippling_hydration"))
            except (ValueError, KeyError, TypeError):
                continue
    if parsed.hostname in {
        "lifeattiktok.com",
        "www.lifeattiktok.com",
        "joinbytedance.com",
        "www.joinbytedance.com",
    }:
        path = re.fullmatch(r"/search/(\d+)/?", parsed.path)
        if not path:
            return results
        records = _flight_records(scripts)
        for record in records.values():
            for props in _walk(record):
                module = props.get("module")
                module_type = (
                    module.get("type") if isinstance(module, dict) else props.get("moduleType")
                )
                if module_type not in {"tt.jobDetailsCommon", "bd.jobDetailsCommon"}:
                    continue
                children = props.get("children")
                ids = {str(item["jobId"]) for item in _walk(children) if "jobId" in item}
                if ids != {path[1]}:
                    continue
                # Title is displayed inside this job module, not taken from unrelated metadata.
                strings = [item.get("children") for item in _walk(children)]
                if not any(
                    isinstance(v, str) and title_is_shortening(normalized_title(title), v)
                    for v in strings
                ):
                    continue
                text = html_to_plaintext(_render(children, records))
                if "Qualifications" in text and (
                    "Responsibilities" in text or "About the Team" in text
                ):
                    results.append((text, "streamed_job_module"))
    return results
