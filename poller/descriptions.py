"""Assemble public source text without classifying its meaning or any applicant."""

from __future__ import annotations

from typing import Any

from poller.normalize import html_to_plaintext


def description_field(data: dict[str, Any], html_key: str, plain_key: str) -> str:
    # Prefer HTML structure, but don't replace a full plaintext body with an HTML teaser.
    values = []
    for key in (html_key, plain_key):
        value = data.get(key)
        values.append(html_to_plaintext(value) if isinstance(value, str) else "")
    rich, plain = values
    if rich and plain:
        compact_rich = " ".join(rich.split()).casefold()
        compact_plain = " ".join(plain.split()).casefold()
        if compact_rich != compact_plain and compact_rich in compact_plain:
            return plain
    return rich or plain


def lever_description(data: dict[str, Any]) -> str:
    parts = [description_field(data, "description", "descriptionPlain")]
    sections = data.get("lists")
    if isinstance(sections, list):
        for section in sections:
            if not isinstance(section, dict):
                continue
            content = section.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            title = section.get("text")
            if isinstance(title, str) and title.strip():
                parts.append(html_to_plaintext(title))
            parts.append(html_to_plaintext(content))
    parts.extend(
        [
            description_field(data, "additional", "additionalPlain"),
            description_field(data, "salaryDescription", "salaryDescriptionPlain"),
        ]
    )
    return "\n\n".join(part for part in parts if part)


def smartrecruiters_description(data: dict[str, Any]) -> str:
    job_ad = data.get("jobAd")
    sections = job_ad.get("sections") if isinstance(job_ad, dict) else None
    candidates: list[Any] = list(sections.values()) if isinstance(sections, dict) else []
    legacy = data.get("jobDescription")
    legacy_sections = legacy.get("sections") if isinstance(legacy, dict) else None
    for source_sections in (candidates, legacy_sections):
        if not isinstance(source_sections, list):
            continue
        parts = []
        for section in source_sections:
            if not isinstance(section, dict):
                continue
            value = section.get("text")
            text = html_to_plaintext(value) if isinstance(value, str) else ""
            if not text:
                continue
            title = section.get("title")
            if isinstance(title, str) and title.strip():
                parts.append(html_to_plaintext(title))
            parts.append(text)
        if parts:
            return "\n\n".join(parts)
    return ""


def source_facts(data: dict[str, Any], provider: str) -> dict[str, Any]:
    if provider == "ashby" and data.get("shouldDisplayCompensationOnJobPostings") is False:
        return {}
    keys = {
        "greenhouse": ["pay_input_ranges"],
        "lever": ["salaryRange"],
        "ashby": ["compensation", "shouldDisplayCompensationOnJobPostings"],
    }.get(provider, [])
    values = {key: data[key] for key in keys if key in data}
    return {"source_compensation": {"provider": provider, "data": values}} if values else {}
