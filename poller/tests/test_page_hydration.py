from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from poller.page_document import extract_document

FIXTURES = Path(__file__).parent / "fixtures" / "page_hydration"


def rippling_html(data: dict[str, Any]) -> str:
    return '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(data) + "</script>"


def test_rippling_server_data_retains_company_role_and_legal_ending() -> None:
    data = json.loads((FIXTURES / "rippling.json").read_text(encoding="utf-8"))
    job = data["props"]["pageProps"]["apiData"]["jobPost"]
    doc = extract_document(rippling_html(data), job["url"], job["name"])
    assert "E-Verify" in doc.text
    assert "Electrical" in doc.text
    assert doc.method == "rippling_hydration"
    job["uuid"] = "different-job"
    with pytest.raises(ValueError, match="matching"):
        extract_document(rippling_html(data), job["url"], job["name"])


def flight_html(records: dict[str, Any]) -> str:
    stream = ""
    for key, value in records.items():
        if isinstance(value, str):
            stream += key + ":T" + format(len(value.encode()), "x") + "," + value
        else:
            stream += key + ":" + json.dumps(value) + "\n"
    # Split within a record to exercise actual streamed chunks, with multibyte text.
    chunks = [stream[:100], stream[100:]]
    return "".join(
        "<script>self.__next_f.push(" + json.dumps([1, chunk]) + ")</script>" for chunk in chunks
    )


def test_tiktok_streamed_description_needs_no_javascript_execution() -> None:
    records = json.loads((FIXTURES / "tiktok-flight.json").read_text(encoding="utf-8"))
    url = "https://lifeattiktok.com/search/7668584916620527925"
    title = "Software Engineer Intern - Business Integrity"
    doc = extract_document(flight_html(records), url, title)
    assert "Minimum Qualifications" in doc.text
    assert "Build highly scalable systems" in doc.text
    assert "Accommodation" in doc.text
    assert doc.status == "partial"
    for bad_url in [
        url.replace("7668584916620527925", "123"),
        url.replace("lifeattiktok.com", "example.com"),
    ]:
        with pytest.raises(ValueError, match="matching"):
            extract_document(flight_html(records), bad_url, title)
    with pytest.raises(ValueError, match="matching"):
        extract_document(flight_html(records), url, "Hardware Engineer Intern")


def test_missing_stream_reference_does_not_silently_truncate() -> None:
    records = json.loads((FIXTURES / "tiktok-flight.json").read_text(encoding="utf-8"))
    del records[next(key for key in records if key != "f")]
    with pytest.raises(ValueError):
        extract_document(
            flight_html(records),
            "https://lifeattiktok.com/search/7668584916620527925",
            "Software Engineer Intern - Business Integrity",
        )


def test_bytedance_module_type_variant_is_bound_to_its_job_id() -> None:
    records = json.loads((FIXTURES / "bytedance-flight.json").read_text(encoding="utf-8"))
    url = "https://joinbytedance.com/search/7670316084662339845"
    doc = extract_document(flight_html(records), url, "Student Researcher - Compiler - Seed Infra")
    assert "Qualifications" in doc.text
    assert "Compiler" in doc.text
    with pytest.raises(ValueError):
        extract_document(
            flight_html(records),
            url.replace("7670316084662339845", "123"),
            "Student Researcher - Compiler - Seed Infra",
        )
