from __future__ import annotations

import json

import pytest

from poller.page_document import extract_document

URL = "https://careers.example.com/job?id=123"
TITLE = "Flight Software Intern"


def structured(description: str, url: str = URL) -> str:
    return (
        '<script type="application/ld+json">'
        + json.dumps(
            {
                "@type": "JobPosting",
                "title": TITLE,
                "url": url,
                "description": description,
            }
        )
        + "</script>"
    )


def test_query_job_identity_must_not_be_discarded() -> None:
    with pytest.raises(ValueError, match="matching"):
        extract_document(structured("Another requisition", URL.replace("123", "456")), URL, TITLE)


def test_tracking_query_does_not_change_job_identity() -> None:
    result = extract_document(structured("Full source text", URL + "&utm_source=feed"), URL, TITLE)
    assert result.text == "Full source text"
    assert result.status == "available"


def test_duplicate_identical_structured_representations_are_one_document() -> None:
    result = extract_document(structured("Full source text") * 2, URL, TITLE)
    assert result.status == "available"


def test_conflicting_structured_representations_are_not_arbitrarily_selected() -> None:
    with pytest.raises(ValueError, match="ambiguous"):
        extract_document(
            structured("First requirement") + structured("Different requirement"), URL, TITLE
        )


def test_visible_description_retains_ending_missing_from_json_ld_without_certifying_it() -> None:
    html = (
        structured("Build flight software.")
        + f"""<h1>{TITLE}</h1>
    <section class="job-description"><p>Build flight software.</p>
    <h2>Requirements</h2><ul><li>Must be enrolled in a degree program.</li></ul>
    <h2>Compensation</h2><p>$35 per hour. No relocation allowance.</p></section>
    <aside>Recommended jobs: Senior Trader</aside>"""
    )
    result = extract_document(html, URL, TITLE)
    assert "No relocation allowance." in result.text
    assert "- Must be enrolled" in result.text
    assert "Senior Trader" not in result.text
    assert result.status == "partial"


def test_microdata_job_scope_preserves_separate_material_fields() -> None:
    html = f'''<article itemscope itemtype="https://schema.org/JobPosting">
    <h1 itemprop="title">{TITLE}</h1><link itemprop="url" href="{URL}">
    <div itemprop="description"><p>Build flight software.</p></div>
    <div itemprop="qualifications"><p>Must graduate in 2028.</p></div>
    <div itemprop="responsibilities"><ul><li>Test navigation systems.</li></ul></div>
    </article><footer>Other jobs and privacy policies</footer>'''
    result = extract_document(html, URL, TITLE)
    assert "Must graduate in 2028." in result.text
    assert "Test navigation systems." in result.text
    assert "Other jobs" not in result.text
    assert result.status == "available"


def test_generic_main_text_is_partial_and_requires_matching_page_title() -> None:
    html = f"<main><h1>{TITLE}</h1><p>You will build flight software.</p></main>"
    assert extract_document(html, URL, TITLE).status == "partial"
    with pytest.raises(ValueError, match="matching"):
        extract_document(html.replace(TITLE, "Senior Trader"), URL, TITLE)


def test_application_form_is_not_a_description() -> None:
    html = f"<main><h1>{TITLE}</h1><form>Name<input>Upload resume<input></form></main>"
    with pytest.raises(ValueError):
        extract_document(html, URL, TITLE)


def test_hydration_is_matched_by_url_and_title_and_kept_as_partial() -> None:
    data = {
        "props": {
            "job": {
                "id": "123",
                "title": TITLE,
                "url": URL,
                "description": "You will develop flight software.",
            }
        }
    }
    html = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(data) + "</script>"
    assert extract_document(html, URL, TITLE).status == "partial"


def test_structured_fields_outside_description_are_not_lost() -> None:
    job = {
        "@type": "JobPosting",
        "url": URL,
        "title": TITLE,
        "description": "Build flight software.",
        "qualifications": "Must be enrolled in a degree program.",
        "responsibilities": "Test navigation systems.",
        "jobBenefits": "Housing is provided.",
    }
    html = '<script type="application/ld+json">' + json.dumps(job) + "</script>"
    result = extract_document(html, URL, TITLE)
    assert "Must be enrolled in a degree program." in result.text
    assert result.text.endswith("Housing is provided.")


def test_structured_identity_is_url_not_upstream_normalized_title() -> None:
    # Feed titles are shortened by the poller/Simplify; the source's own JobPosting
    # title is the fuller original. A JSON-LD JobPosting whose url matches exactly is
    # the job regardless of title wording; requiring title equality discarded valid
    # descriptions (e.g. jazzhr "...Internship or Co-op 2027" vs feed "...Intern Co-op").
    html = (
        '<script type="application/ld+json">'
        + json.dumps(
            {
                "@type": "JobPosting",
                "title": "Flight Software Internship or Co-op 2027",
                "url": URL,
                "description": "Build flight software.",
            }
        )
        + "</script>"
    )
    result = extract_document(html, URL, TITLE)
    assert result.text == "Build flight software."
    assert result.status == "available"
    assert result.method == "json_ld"


def test_structured_url_mismatch_still_rejected_even_with_matching_title() -> None:
    # Relaxing the title gate must not weaken url identity: a JobPosting at a different
    # job id is not this job even when its title equals the requested title.
    with pytest.raises(ValueError, match="matching"):
        extract_document(structured("Another requisition", URL.replace("123", "456")), URL, TITLE)


def test_conflicts_in_one_json_array_remain_visible_to_validator() -> None:
    jobs = [
        {"@type": "JobPosting", "url": URL, "title": TITLE, "description": text}
        for text in ("First description", "Different description")
    ]
    html = '<script type="application/ld+json">' + json.dumps(jobs) + "</script>"
    with pytest.raises(ValueError, match="ambiguous"):
        extract_document(html, URL, TITLE)


@pytest.mark.parametrize(
    ("feed_title", "source_title"),
    [
        ("Intern", "Internal Auditor"),
        ("Engineer II", "Engineer III"),
        ("Software Engineer", "Senior Software Engineer"),
        ("Summer Analyst", "Summer Associate"),
        ("Summer Analyst 2027", "Summer Analyst 2026"),
        ("C++ Engineer Intern", "C# Engineer Intern"),
        ("", "Software Intern"),
    ],
)
def test_title_shortening_rejects_changed_role(feed_title: str, source_title: str) -> None:
    html = (
        '<script type="application/ld+json">'
        + json.dumps(
            {
                "@type": "JobPosting",
                "url": URL,
                "title": source_title,
                "description": "Source job duties.",
            }
        )
        + "</script>"
    )
    with pytest.raises(ValueError, match="matching"):
        extract_document(html, URL, feed_title)


@pytest.mark.parametrize(
    ("feed_title", "source_title"),
    [
        ("Summer Analyst", "2027 Investment Banking Summer Analyst"),
        ("Summer Associate", "2027 Summer Associate - Investment Banking"),
        ("Software Engineer Intern", "Software Engineering Intern"),
        ("Flight Software Intern", "Flight Software Internship or Co-op 2027"),
        (
            "Engineering Technician Co-op - Nanoready",
            "NanoReady- Engineering Technician-Co-Op Fall 2026",
        ),
    ],
)
def test_shortened_student_titles_keep_their_actual_role(
    feed_title: str, source_title: str
) -> None:
    html = (
        '<script type="application/ld+json">'
        + json.dumps(
            {
                "@type": "JobPosting",
                "url": URL,
                "title": source_title,
                "description": "Source job duties.",
            }
        )
        + "</script>"
    )
    assert extract_document(html, URL, feed_title).text == "Source job duties."


def test_icims_matches_requisition_not_cosmetic_slug_or_mobile_options() -> None:
    url = "https://careers-example.icims.com/jobs/123/job?mobile=true&needsRedirect=false"
    canonical = "https://careers-example.icims.com/jobs/123/flight-software-intern/job"
    assert extract_document(structured("Full duties", canonical), url, TITLE).text == "Full duties"
    with pytest.raises(ValueError, match="matching"):
        extract_document(
            structured("Wrong requisition", canonical.replace("/123/", "/124/")), url, TITLE
        )
    with pytest.raises(ValueError, match="matching"):
        extract_document(
            structured("Wrong employer", canonical.replace("careers-example.", "careers-other.")),
            url,
            TITLE,
        )
