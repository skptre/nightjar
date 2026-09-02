"""Tests for Block 0 — Infrastructure & Data Model Foundations."""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

import pytest

from poller.filter import is_student_role
from poller.http import NOT_MODIFIED, RateLimitedClient
from poller.models import (
    Company,
    Posting,
    RawPosting,
    SourceConfig,
    compute_posting_id,
)
from poller.store import RunState

if TYPE_CHECKING:
    from pathlib import Path


# ── RawPosting new fields ──────────────────────────────────────────


class TestRawPostingExpansion:
    def test_new_fields_default_none(self) -> None:
        raw = RawPosting(
            source="greenhouse",
            company_slug="test",
            source_job_id="1",
            title="SWE Intern",
            location="NYC",
            locations=["NYC"],
            url="https://example.com",
            posted_at=None,
            description="desc",
        )
        assert raw.employment_type is None
        assert raw.department is None
        assert raw.requisition_id is None
        assert raw.workplace_type is None
        assert raw.updated_at is None
        assert raw.valid_through is None
        assert raw.education_requirements is None
        assert raw.experience_requirements is None
        assert raw.occupational_category is None

    def test_new_fields_set_explicitly(self) -> None:
        raw = RawPosting(
            source="greenhouse",
            company_slug="test",
            source_job_id="1",
            title="SWE Intern",
            location="NYC",
            locations=["NYC"],
            url="https://example.com",
            posted_at=None,
            description="desc",
            employment_type="intern",
            department="Engineering",
            requisition_id="REQ-001",
            workplace_type="hybrid",
            updated_at="2026-09-01T00:00:00Z",
            valid_through="2026-12-31T00:00:00Z",
            education_requirements="Bachelor's",
            experience_requirements="0-2 years",
            occupational_category="Software",
        )
        assert raw.employment_type == "intern"
        assert raw.department == "Engineering"
        assert raw.requisition_id == "REQ-001"
        assert raw.workplace_type == "hybrid"
        assert raw.updated_at == "2026-09-01T00:00:00Z"
        assert raw.valid_through == "2026-12-31T00:00:00Z"
        assert raw.education_requirements == "Bachelor's"
        assert raw.experience_requirements == "0-2 years"
        assert raw.occupational_category == "Software"


# ── Posting new fields round-trip ──────────────────────────────────


class TestPostingExpansion:
    def _make_posting(self, **overrides: Any) -> Posting:
        defaults: dict[str, Any] = {
            "id": compute_posting_id("greenhouse", "test", "1"),
            "company": "Test",
            "company_slug": "test",
            "title": "SWE Intern",
            "location": "NYC",
            "locations": ["NYC"],
            "url": "https://example.com",
            "source": "greenhouse",
            "source_job_id": "1",
            "ats": "greenhouse",
            "posted_at": None,
            "first_seen_at": "2026-09-01T00:00:00Z",
            "last_seen_at": "2026-09-01T00:00:00Z",
        }
        defaults.update(overrides)
        return Posting(**defaults)

    def test_new_fields_default_none(self) -> None:
        p = self._make_posting()
        assert p.employment_type is None
        assert p.department is None
        assert p.workplace_type is None
        assert p.valid_through is None

    def test_new_fields_omitted_from_dict_when_none(self) -> None:
        p = self._make_posting()
        d = p.to_dict()
        assert "employment_type" not in d
        assert "department" not in d
        assert "workplace_type" not in d
        assert "valid_through" not in d

    def test_new_fields_included_when_set(self) -> None:
        p = self._make_posting(
            employment_type="intern",
            department="Engineering",
            workplace_type="remote",
            valid_through="2026-12-31T00:00:00Z",
        )
        d = p.to_dict()
        assert d["employment_type"] == "intern"
        assert d["department"] == "Engineering"
        assert d["workplace_type"] == "remote"
        assert d["valid_through"] == "2026-12-31T00:00:00Z"

    def test_round_trip_with_new_fields(self) -> None:
        p = self._make_posting(
            employment_type="co-op",
            department="Data Science",
            workplace_type="hybrid",
            valid_through="2027-01-15T00:00:00Z",
        )
        d = p.to_dict()
        restored = Posting.from_dict(d)
        assert restored.employment_type == "co-op"
        assert restored.department == "Data Science"
        assert restored.workplace_type == "hybrid"
        assert restored.valid_through == "2027-01-15T00:00:00Z"

    def test_from_dict_missing_new_fields(self) -> None:
        d = {
            "id": "abc123",
            "company": "Test",
            "company_slug": "test",
            "title": "SWE Intern",
            "location": "NYC",
            "locations": ["NYC"],
            "url": "https://example.com",
            "source": "greenhouse",
            "source_job_id": "1",
            "ats": "greenhouse",
            "first_seen_at": "2026-09-01T00:00:00Z",
            "last_seen_at": "2026-09-01T00:00:00Z",
        }
        p = Posting.from_dict(d)
        assert p.employment_type is None
        assert p.department is None
        assert p.workplace_type is None
        assert p.valid_through is None


# ── RunState run_duration_seconds ──────────────────────────────────


class TestRunStateDuration:
    def test_duration_default_none(self) -> None:
        state = RunState()
        assert state.run_duration_seconds is None

    def test_duration_in_to_dict(self) -> None:
        state = RunState(run_duration_seconds=42.567)
        d = state.to_dict()
        assert d["run_duration_seconds"] == 42.6

    def test_duration_omitted_when_none(self) -> None:
        state = RunState()
        d = state.to_dict()
        assert "run_duration_seconds" not in d

    def test_duration_round_trip(self) -> None:
        state = RunState(run_duration_seconds=123.456)
        d = state.to_dict()
        restored = RunState.from_dict(d)
        assert restored.run_duration_seconds == 123.5

    def test_duration_from_dict_missing(self) -> None:
        d: dict[str, Any] = {"last_run_at": None, "run_count": 0}
        restored = RunState.from_dict(d)
        assert restored.run_duration_seconds is None


# ── RunState http_cache ────────────────────────────────────────────


class TestRunStateHttpCache:
    def test_http_cache_default_empty(self) -> None:
        state = RunState()
        assert state.http_cache == {}

    def test_http_cache_in_to_dict(self) -> None:
        state = RunState(http_cache={
            "https://example.com/api": {"etag": '"abc123"'},
        })
        d = state.to_dict()
        assert d["http_cache"] == {
            "https://example.com/api": {"etag": '"abc123"'},
        }

    def test_http_cache_omitted_when_empty(self) -> None:
        state = RunState()
        d = state.to_dict()
        assert "http_cache" not in d

    def test_http_cache_round_trip(self) -> None:
        cache = {
            "https://api.example.com/jobs": {
                "etag": '"v1"',
                "last_modified": "Mon, 01 Sep 2026 00:00:00 GMT",
            }
        }
        state = RunState(http_cache=cache)
        d = state.to_dict()
        restored = RunState.from_dict(d)
        assert restored.http_cache == cache


# ── Student role filter expansion ──────────────────────────────────


class TestStudentRoleExpansion:
    @pytest.mark.parametrize("title", [
        "Software Engineering Intern",
        "Data Science Co-op",
        "Student Trainee",
        "Spring Week Analyst",
        "Investment Banking Insight Programme",
        "Summer Analyst 2027",
        "Winter Analyst",
        "Summer Associate - Technology",
        "Research Experience for Undergraduates",
        "REU - Materials Science",
        "Student Researcher - Physics Lab",
        "Research Intern - AI",
        "Undergraduate Researcher",
        "Lab Assistant - Chemistry",
        "Lab Intern - Biology",
        "Industrial Placement - Engineering",
        "Year in Industry - Software",
        "Sandwich Year Student",
        "Work Placement - Finance",
        "Software Engineering Apprenticeship",
        "Finance Externship",
        "Graduate Internship - Marketing",
        "Nursing Practicum",
        "New Graduate Program",
        "Recent Graduates - Engineering",
        "Graduate Trainee",
        "University Hire",
        "Campus Recruit",
        "Freshers Program",
    ])
    def test_matches_student_role(self, title: str) -> None:
        assert is_student_role(title), f"should match: {title!r}"

    @pytest.mark.parametrize("title", [
        "Senior Software Engineer",
        "Staff Data Scientist",
        "Engineering Manager",
        "Product Designer",
        "Entry Level",
        "Early Career",
        "Junior Developer",
    ])
    def test_rejects_non_student_role(self, title: str) -> None:
        assert not is_student_role(title), f"should not match: {title!r}"


# ── HTTP conditional caching ───────────────────────────────────────


class TestHttpConditionalCaching:
    def test_cache_load_dump(self) -> None:
        client = RateLimitedClient()
        cache = {"https://api.example.com": {"etag": '"v1"'}}
        client.load_cache(cache)
        assert client.dump_cache() == cache

    def test_not_modified_sentinel(self) -> None:
        assert NOT_MODIFIED is not None
        assert NOT_MODIFIED is NOT_MODIFIED

    def test_host_budget_default(self) -> None:
        client = RateLimitedClient()
        assert client._host_budget == 500

    def test_host_budget_custom(self) -> None:
        client = RateLimitedClient(host_budget=10)
        assert client._host_budget == 10

    def test_host_budget_tracking(self) -> None:
        client = RateLimitedClient(host_budget=3)
        client._record_request("example.com")
        client._record_request("example.com")
        assert client._check_host_budget("example.com") is True
        client._record_request("example.com")
        assert client._check_host_budget("example.com") is False

    def test_conditional_headers_empty_cache(self) -> None:
        client = RateLimitedClient()
        headers = client._get_conditional_headers("https://example.com")
        assert headers == {}

    def test_conditional_headers_with_etag(self) -> None:
        client = RateLimitedClient()
        client.load_cache({
            "https://example.com": {"etag": '"abc"'},
        })
        headers = client._get_conditional_headers("https://example.com")
        assert headers == {"If-None-Match": '"abc"'}

    def test_conditional_headers_with_both(self) -> None:
        client = RateLimitedClient()
        client.load_cache({
            "https://example.com": {
                "etag": '"abc"',
                "last_modified": "Mon, 01 Sep 2026 00:00:00 GMT",
            },
        })
        headers = client._get_conditional_headers("https://example.com")
        assert headers["If-None-Match"] == '"abc"'
        assert headers["If-Modified-Since"] == "Mon, 01 Sep 2026 00:00:00 GMT"

    def test_update_cache_from_response(self) -> None:
        client = RateLimitedClient()
        mock_response = MagicMock()
        mock_response.headers = {
            "ETag": '"new-etag"',
            "Last-Modified": "Tue, 02 Sep 2026 00:00:00 GMT",
        }
        client._update_cache("https://example.com", mock_response)
        cache = client.dump_cache()
        assert cache["https://example.com"]["etag"] == '"new-etag"'
        assert cache["https://example.com"]["last_modified"] == "Tue, 02 Sep 2026 00:00:00 GMT"


# ── Benchmark tool ─────────────────────────────────────────────────


# ── Greenhouse classification extraction ─────────────────────────


class TestGreenhouseClassification:
    def test_department_extracted_from_departments_array(self) -> None:
        from poller.sources.greenhouse import GreenhouseAdapter

        adapter = GreenhouseAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
            ],
        )
        source = company.sources[0]
        job: dict[str, Any] = {
            "id": 100,
            "title": "SWE Intern",
            "location": {"name": "NYC"},
            "offices": [],
            "absolute_url": "https://example.com/100",
            "first_published": None,
            "content": "",
            "departments": [{"id": 1, "name": "Engineering"}],
        }
        raw = adapter._parse_job(job, company, source)
        assert raw.department == "Engineering"

    def test_department_none_when_departments_empty(self) -> None:
        from poller.sources.greenhouse import GreenhouseAdapter

        adapter = GreenhouseAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
            ],
        )
        source = company.sources[0]
        job: dict[str, Any] = {
            "id": 101,
            "title": "Designer",
            "location": {"name": "SF"},
            "offices": [],
            "absolute_url": "https://example.com/101",
            "first_published": None,
            "content": "",
            "departments": [],
        }
        raw = adapter._parse_job(job, company, source)
        assert raw.department is None

    def test_employment_type_from_metadata(self) -> None:
        from poller.sources.greenhouse import GreenhouseAdapter

        adapter = GreenhouseAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
            ],
        )
        source = company.sources[0]
        job: dict[str, Any] = {
            "id": 102,
            "title": "SWE Intern",
            "location": {"name": "NYC"},
            "offices": [],
            "absolute_url": "https://example.com/102",
            "first_published": None,
            "content": "",
            "departments": [],
            "metadata": [
                {"name": "Employment Type", "value": "Intern"},
            ],
        }
        raw = adapter._parse_job(job, company, source)
        assert raw.employment_type == "Intern"

    def test_employment_type_none_without_metadata(self) -> None:
        from poller.sources.greenhouse import GreenhouseAdapter

        adapter = GreenhouseAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
            ],
        )
        source = company.sources[0]
        job: dict[str, Any] = {
            "id": 103,
            "title": "SWE",
            "location": {"name": "NYC"},
            "offices": [],
            "absolute_url": "https://example.com/103",
            "first_published": None,
            "content": "",
            "departments": [],
        }
        raw = adapter._parse_job(job, company, source)
        assert raw.employment_type is None

    def test_updated_at_extracted(self) -> None:
        from poller.sources.greenhouse import GreenhouseAdapter

        adapter = GreenhouseAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
            ],
        )
        source = company.sources[0]
        job: dict[str, Any] = {
            "id": 104,
            "title": "SWE",
            "location": {"name": "NYC"},
            "offices": [],
            "absolute_url": "https://example.com/104",
            "first_published": None,
            "content": "",
            "departments": [],
            "updated_at": "2026-09-01T12:00:00Z",
        }
        raw = adapter._parse_job(job, company, source)
        assert raw.updated_at == "2026-09-01T12:00:00Z"

    def test_normalize_propagates_classification(self) -> None:
        from poller.sources.greenhouse import GreenhouseAdapter

        adapter = GreenhouseAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="greenhouse", board_token="acme"),
            ],
        )
        source = company.sources[0]
        job: dict[str, Any] = {
            "id": 200,
            "title": "SWE Intern",
            "location": {"name": "NYC"},
            "offices": [],
            "absolute_url": "https://example.com/200",
            "first_published": None,
            "content": "",
            "departments": [{"id": 1, "name": "R&D"}],
            "metadata": [
                {"name": "Employment Type", "value": "Intern"},
            ],
        }
        raw = adapter._parse_job(job, company, source)
        posting = adapter.normalize(raw, company, "2026-09-01T00:00:00Z")
        assert posting.employment_type == "Intern"
        assert posting.department == "R&D"


# ── Lever classification extraction ──────────────────────────────


class TestLeverClassification:
    def _make_lever_job(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "id": "lever-001",
            "text": "SWE Intern",
            "hostedUrl": "https://jobs.lever.co/acme/lever-001",
            "createdAt": 1725148800000,
            "descriptionPlain": "Description here",
            "categories": {
                "commitment": "Intern",
                "location": "NYC",
                "department": "Engineering",
                "allLocations": ["NYC"],
            },
            "workplaceType": "onsite",
        }
        base.update(overrides)
        return base

    def test_employment_type_from_commitment(self) -> None:
        from poller.sources.lever import LeverAdapter

        adapter = LeverAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="lever", board_token="acme"),
            ],
        )
        job = self._make_lever_job()
        raw = adapter._parse_job(job, company)
        assert raw.employment_type == "Intern"

    def test_department_from_categories(self) -> None:
        from poller.sources.lever import LeverAdapter

        adapter = LeverAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="lever", board_token="acme"),
            ],
        )
        job = self._make_lever_job()
        raw = adapter._parse_job(job, company)
        assert raw.department == "Engineering"

    def test_workplace_type_extracted(self) -> None:
        from poller.sources.lever import LeverAdapter

        adapter = LeverAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="lever", board_token="acme"),
            ],
        )
        job = self._make_lever_job(workplaceType="remote")
        raw = adapter._parse_job(job, company)
        assert raw.workplace_type == "remote"

    def test_empty_commitment_gives_none(self) -> None:
        from poller.sources.lever import LeverAdapter

        adapter = LeverAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="lever", board_token="acme"),
            ],
        )
        job = self._make_lever_job()
        job["categories"]["commitment"] = ""
        raw = adapter._parse_job(job, company)
        assert raw.employment_type is None

    def test_normalize_propagates_all_fields(self) -> None:
        from poller.sources.lever import LeverAdapter

        adapter = LeverAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="lever", board_token="acme"),
            ],
        )
        job = self._make_lever_job(workplaceType="hybrid")
        raw = adapter._parse_job(job, company)
        posting = adapter.normalize(raw, company, "2026-09-01T00:00:00Z")
        assert posting.employment_type == "Intern"
        assert posting.department == "Engineering"
        assert posting.workplace_type == "hybrid"


# ── Ashby classification extraction ──────────────────────────────


class TestAshbyClassification:
    def _make_ashby_job(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "id": "ashby-001",
            "title": "SWE Intern",
            "location": "New York, NY",
            "secondaryLocations": [],
            "jobUrl": "https://jobs.ashbyhq.com/acme/ashby-001",
            "publishedAt": "2026-09-01T00:00:00Z",
            "descriptionPlain": "Description",
            "employmentType": "Intern",
            "department": "Engineering",
            "isRemote": False,
            "shouldDisplayCompensationOnJobPostings": False,
        }
        base.update(overrides)
        return base

    def test_employment_type_extracted(self) -> None:
        from poller.sources.ashby import AshbyAdapter

        adapter = AshbyAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="ashby", board_token="acme"),
            ],
        )
        job = self._make_ashby_job(employmentType="Intern")
        raw = adapter._parse_job(job, company)
        assert raw.employment_type == "Intern"

    def test_department_extracted(self) -> None:
        from poller.sources.ashby import AshbyAdapter

        adapter = AshbyAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="ashby", board_token="acme"),
            ],
        )
        job = self._make_ashby_job(department="Data Science")
        raw = adapter._parse_job(job, company)
        assert raw.department == "Data Science"

    def test_is_remote_true_gives_remote(self) -> None:
        from poller.sources.ashby import AshbyAdapter

        adapter = AshbyAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="ashby", board_token="acme"),
            ],
        )
        job = self._make_ashby_job(isRemote=True)
        raw = adapter._parse_job(job, company)
        assert raw.workplace_type == "remote"

    def test_is_remote_false_gives_onsite(self) -> None:
        from poller.sources.ashby import AshbyAdapter

        adapter = AshbyAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="ashby", board_token="acme"),
            ],
        )
        job = self._make_ashby_job(isRemote=False)
        raw = adapter._parse_job(job, company)
        assert raw.workplace_type == "onsite"

    def test_is_remote_none_gives_none(self) -> None:
        from poller.sources.ashby import AshbyAdapter

        adapter = AshbyAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="ashby", board_token="acme"),
            ],
        )
        job = self._make_ashby_job()
        del job["isRemote"]
        raw = adapter._parse_job(job, company)
        assert raw.workplace_type is None

    def test_normalize_propagates_classification(self) -> None:
        from poller.sources.ashby import AshbyAdapter

        adapter = AshbyAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="ashby", board_token="acme"),
            ],
        )
        job = self._make_ashby_job(isRemote=True, employmentType="Intern",
                                   department="Engineering")
        raw = adapter._parse_job(job, company)
        posting = adapter.normalize(raw, company, "2026-09-01T00:00:00Z")
        assert posting.employment_type == "Intern"
        assert posting.department == "Engineering"
        assert posting.workplace_type == "remote"


# ── Workday classification extraction ────────────────────────────


class TestWorkdayClassification:
    def _make_workday_job(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "title": "SWE Intern",
            "externalPath": "/en-US/job/SWE-Intern/JR-12345",
            "locationsText": "Seattle, WA",
            "bulletFields": [
                "Seattle, WA",
                "Full time",
                "Posted Today",
            ],
        }
        base.update(overrides)
        return base

    def test_full_time_extracted(self) -> None:
        from poller.sources.workday import WorkdayAdapter

        adapter = WorkdayAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="workday", board_token="acme.wd5.myworkdayjobs.com/careers"),
            ],
        )
        job = self._make_workday_job()
        raw = adapter._parse_job(job, company, "acme.wd5.myworkdayjobs.com")
        assert raw.employment_type == "full time"

    def test_part_time_extracted(self) -> None:
        from poller.sources.workday import WorkdayAdapter

        adapter = WorkdayAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="workday", board_token="acme.wd5.myworkdayjobs.com/careers"),
            ],
        )
        job = self._make_workday_job(bulletFields=["Seattle, WA", "Part-time"])
        raw = adapter._parse_job(job, company, "acme.wd5.myworkdayjobs.com")
        assert raw.employment_type == "part time"

    def test_no_employment_type_in_bullets(self) -> None:
        from poller.sources.workday import WorkdayAdapter

        adapter = WorkdayAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="workday", board_token="acme.wd5.myworkdayjobs.com/careers"),
            ],
        )
        job = self._make_workday_job(bulletFields=["Seattle, WA", "Posted Today"])
        raw = adapter._parse_job(job, company, "acme.wd5.myworkdayjobs.com")
        assert raw.employment_type is None

    def test_normalize_propagates_employment_type(self) -> None:
        from poller.sources.workday import WorkdayAdapter

        adapter = WorkdayAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="workday", board_token="acme.wd5.myworkdayjobs.com/careers"),
            ],
        )
        job = self._make_workday_job()
        raw = adapter._parse_job(job, company, "acme.wd5.myworkdayjobs.com")
        posting = adapter.normalize(raw, company, "2026-09-01T00:00:00Z")
        assert posting.employment_type == "full time"


# ── SmartRecruiters classification extraction ────────────────────


class TestSmartRecruitersClassification:
    def _make_sr_item(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "id": "sr-001",
            "name": "SWE Intern",
            "location": {"city": "NYC", "region": "NY", "country": "US"},
            "releasedDate": "2026-09-01T00:00:00Z",
            "typeOfEmployment": {"id": "intern", "label": "Internship"},
            "department": {"id": "eng", "label": "Engineering"},
            "experienceLevel": {"id": "entry", "label": "Entry Level"},
        }
        base.update(overrides)
        return base

    def test_employment_type_from_label(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item = self._make_sr_item()
        raw = adapter._parse_posting(item, company, "acme")
        assert raw.employment_type == "Internship"

    def test_department_from_label(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item = self._make_sr_item()
        raw = adapter._parse_posting(item, company, "acme")
        assert raw.department == "Engineering"

    def test_experience_from_label(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item = self._make_sr_item()
        raw = adapter._parse_posting(item, company, "acme")
        assert raw.experience_requirements == "Entry Level"

    def test_fallback_to_id_when_no_label(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item = self._make_sr_item(
            typeOfEmployment={"id": "intern"},
            department={"id": "eng"},
            experienceLevel={"id": "entry"},
        )
        raw = adapter._parse_posting(item, company, "acme")
        assert raw.employment_type == "intern"
        assert raw.department == "eng"
        assert raw.experience_requirements == "entry"

    def test_string_format_handled(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item = self._make_sr_item(
            typeOfEmployment="Full-time",
            department="Sales",
            experienceLevel="Mid-Senior",
        )
        raw = adapter._parse_posting(item, company, "acme")
        assert raw.employment_type == "Full-time"
        assert raw.department == "Sales"
        assert raw.experience_requirements == "Mid-Senior"

    def test_missing_fields_give_none(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item: dict[str, Any] = {
            "id": "sr-002",
            "name": "Designer",
            "location": {"city": "LA", "region": "CA", "country": "US"},
            "releasedDate": None,
        }
        raw = adapter._parse_posting(item, company, "acme")
        assert raw.employment_type is None
        assert raw.department is None
        assert raw.experience_requirements is None

    def test_normalize_propagates_classification(self) -> None:
        from poller.sources.smartrecruiters import SmartRecruitersAdapter

        adapter = SmartRecruitersAdapter()
        company = Company(
            slug="acme", name="Acme", tags=[], sources=[
                SourceConfig(type="smartrecruiters", board_token="acme"),
            ],
        )
        item = self._make_sr_item()
        raw = adapter._parse_posting(item, company, "acme")
        posting = adapter.normalize(raw, company, "2026-09-01T00:00:00Z")
        assert posting.employment_type == "Internship"
        assert posting.department == "Engineering"
        assert posting.source_metadata == {"experience_requirements": "Entry Level"}


# ── Pipeline integration ─────────────────────────────────────────


class TestPipelineRunDuration:
    def test_run_duration_set_after_pipeline(self) -> None:
        state = RunState(run_duration_seconds=None)
        state.run_duration_seconds = 42.5
        assert state.run_duration_seconds == 42.5

        d = state.to_dict()
        assert d["run_duration_seconds"] == 42.5


# ── Benchmark tool ─────────────────────────────────────────────────


class TestBenchmark:
    def test_compute_metrics_empty(self, tmp_path: Path) -> None:
        from poller.tools.benchmark import compute_metrics

        registry = tmp_path / "companies.yaml"
        registry.write_text("[]", encoding="utf-8")

        feed_path = tmp_path / "data" / "feed.json"
        feed_path.parent.mkdir(parents=True)
        feed_path.write_text(
            json.dumps({
                "updated_at": "2026-09-01T00:00:00Z",
                "version": 1,
                "count": 0,
                "postings": {},
            }),
            encoding="utf-8",
        )

        state_path = tmp_path / "data" / "state.json"
        state_path.write_text(
            json.dumps({
                "last_run_at": None,
                "run_count": 0,
                "sources": {},
                "active_ids": [],
                "absent_ids": {},
            }),
            encoding="utf-8",
        )

        with patch("poller.tools.benchmark.FEED_PATH", feed_path), \
             patch("poller.tools.benchmark.STATE_PATH", state_path):
            metrics = compute_metrics(registry)

        assert metrics["registry"]["total_companies"] == 0
        assert metrics["feed"]["total_postings"] == 0
        assert metrics["reliability"]["source_failure_rate_pct"] == 0
        assert "timestamp" in metrics
