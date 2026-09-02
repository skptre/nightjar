from __future__ import annotations

from poller.dedupe import (
    SOURCE_PRIORITY,
    canonicalize_url,
    dedupe_postings,
)
from poller.models import Posting, compute_posting_id

NOW = "2026-09-01T12:00:00Z"
EARLIER = "2026-08-20T08:00:00Z"


def _posting(
    source: str = "greenhouse",
    company_slug: str = "acme",
    source_job_id: str = "100",
    title: str = "Software Engineering Intern",
    location: str = "New York, NY",
    locations: list[str] | None = None,
    url: str = "",
    posted_at: str | None = NOW,
    first_seen_at: str = NOW,
    last_seen_at: str = NOW,
    source_metadata: dict[str, object] | None = None,
) -> Posting:
    if not url:
        url = f"https://example.com/{source}/{company_slug}/jobs/{source_job_id}"
    posting_id = compute_posting_id(source, company_slug, source_job_id)
    return Posting(
        id=posting_id,
        company="Acme Corp",
        company_slug=company_slug,
        title=title,
        location=location,
        locations=locations if locations is not None else [location] if location else [],
        url=url,
        source=source,
        source_job_id=source_job_id,
        ats=source,
        posted_at=posted_at,
        first_seen_at=first_seen_at,
        last_seen_at=last_seen_at,
        source_metadata=source_metadata,
    )


# ---------------------------------------------------------------------------
# URL canonicalization
# ---------------------------------------------------------------------------


class TestCanonicalizeUrlUniversal:
    def test_strips_utm_params(self) -> None:
        url = "https://example.com/jobs/123?utm_source=twitter&utm_medium=social&utm_campaign=fall"
        assert canonicalize_url(url) == "https://example.com/jobs/123"

    def test_strips_fbclid(self) -> None:
        url = "https://example.com/jobs/123?fbclid=abc123"
        assert canonicalize_url(url) == "https://example.com/jobs/123"

    def test_strips_gclid(self) -> None:
        url = "https://example.com/jobs/123?gclid=xyz"
        assert canonicalize_url(url) == "https://example.com/jobs/123"

    def test_strips_mc_params(self) -> None:
        url = "https://example.com/jobs/123?mc_cid=abc&mc_eid=def"
        assert canonicalize_url(url) == "https://example.com/jobs/123"

    def test_strips_ref_and_source_tracking(self) -> None:
        url = "https://example.com/jobs/123?ref=linkedin&source=email"
        assert canonicalize_url(url) == "https://example.com/jobs/123"

    def test_lowercases_scheme_and_host(self) -> None:
        url = "HTTPS://EXAMPLE.COM/Jobs/123"
        assert canonicalize_url(url) == "https://example.com/Jobs/123"

    def test_removes_trailing_slash(self) -> None:
        url = "https://example.com/jobs/123/"
        assert canonicalize_url(url) == "https://example.com/jobs/123"

    def test_sorts_remaining_query_params(self) -> None:
        url = "https://example.com/jobs/123?z=1&a=2"
        assert canonicalize_url(url) == "https://example.com/jobs/123?a=2&z=1"

    def test_preserves_non_tracking_params(self) -> None:
        url = "https://example.com/jobs?department=eng&team=platform"
        result = canonicalize_url(url)
        assert "department=eng" in result
        assert "team=platform" in result

    def test_empty_url_returns_empty(self) -> None:
        assert canonicalize_url("") == ""

    def test_no_query_params_unchanged(self) -> None:
        url = "https://example.com/jobs/123"
        assert canonicalize_url(url) == url


class TestCanonicalizeUrlGreenhouse:
    def test_strips_gh_src(self) -> None:
        url = "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc"
        assert canonicalize_url(url, provider="greenhouse") == (
            "https://boards.greenhouse.io/acme/jobs/123"
        )

    def test_keeps_gh_jid_by_default(self) -> None:
        url = "https://boards.greenhouse.io/acme/jobs/123?gh_jid=456"
        result = canonicalize_url(url, provider="greenhouse")
        assert "gh_jid=456" in result

    def test_strips_gh_jid_when_source_job_id_captured(self) -> None:
        url = "https://boards.greenhouse.io/acme/jobs/123?gh_jid=456"
        result = canonicalize_url(
            url, provider="greenhouse", has_source_job_id=True,
        )
        assert "gh_jid" not in result

    def test_three_distinct_jobs_stay_distinct(self) -> None:
        urls = [
            "https://boards.greenhouse.io/acme/jobs/100?gh_src=abc",
            "https://boards.greenhouse.io/acme/jobs/200?gh_src=def",
            "https://boards.greenhouse.io/acme/jobs/300?gh_src=ghi",
        ]
        canonical = [canonicalize_url(u, provider="greenhouse") for u in urls]
        assert len(set(canonical)) == 3


class TestCanonicalizeUrlLever:
    def test_strips_lever_origin(self) -> None:
        url = "https://jobs.lever.co/acme/abc-123?lever_origin=applied"
        result = canonicalize_url(url, provider="lever")
        assert "lever_origin" not in result

    def test_strips_lever_source(self) -> None:
        url = "https://jobs.lever.co/acme/abc-123?lever_source=linkedin"
        result = canonicalize_url(url, provider="lever")
        assert "lever_source" not in result

    def test_three_distinct_jobs_stay_distinct(self) -> None:
        urls = [
            "https://jobs.lever.co/acme/aaa-111?lever_origin=applied",
            "https://jobs.lever.co/acme/bbb-222?lever_origin=applied",
            "https://jobs.lever.co/acme/ccc-333?lever_source=linkedin",
        ]
        canonical = [canonicalize_url(u, provider="lever") for u in urls]
        assert len(set(canonical)) == 3


class TestCanonicalizeUrlWorkday:
    def test_strips_source_param(self) -> None:
        url = "https://company.wd5.myworkdayjobs.com/jobs/job/NY/SWE_123?source=Indeed"
        result = canonicalize_url(url, provider="workday")
        assert "source=" not in result

    def test_strips_locale_param(self) -> None:
        url = "https://company.wd5.myworkdayjobs.com/jobs/job/NY/SWE_123?locale=en_US"
        result = canonicalize_url(url, provider="workday")
        assert "locale=" not in result

    def test_three_distinct_jobs_stay_distinct(self) -> None:
        urls = [
            "https://company.wd5.myworkdayjobs.com/jobs/job/NY/SWE-Intern_R001?source=Indeed",
            "https://company.wd5.myworkdayjobs.com/jobs/job/SF/ML-Intern_R002?source=Indeed",
            "https://company.wd5.myworkdayjobs.com/jobs/job/LA/Data-Intern_R003?locale=en_US",
        ]
        canonical = [canonicalize_url(u, provider="workday") for u in urls]
        assert len(set(canonical)) == 3


class TestCanonicalizeUrlGeneric:
    def test_generic_strips_only_universal(self) -> None:
        url = "https://careers.example.com/jobs/123?custom=keep&utm_source=strip"
        result = canonicalize_url(url, provider="generic")
        assert "custom=keep" in result
        assert "utm_source" not in result

    def test_unknown_provider_uses_generic_rules(self) -> None:
        url = "https://example.com/jobs/123?ref=linkedin&department=eng"
        result = canonicalize_url(url, provider="unknown_ats")
        assert "department=eng" in result
        assert "ref=" not in result


# ---------------------------------------------------------------------------
# Match hierarchy: canonical URL match
# ---------------------------------------------------------------------------


class TestUrlBasedMatch:
    def test_same_canonical_url_different_tracking_merged(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            url="https://boards.greenhouse.io/acme/jobs/100?gh_src=abc",
        )
        b = _posting(
            source="simplify", source_job_id="ext-100",
            url="https://boards.greenhouse.io/acme/jobs/100?utm_source=simplify",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1

    def test_different_urls_not_merged_by_url_alone(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            url="https://boards.greenhouse.io/acme/jobs/100",
            title="SWE Intern",
        )
        b = _posting(
            source="simplify", source_job_id="2",
            url="https://boards.greenhouse.io/acme/jobs/200",
            title="ML Engineer",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 2


# ---------------------------------------------------------------------------
# Match hierarchy: requisition ID match
# ---------------------------------------------------------------------------


class TestRequisitionIdMatch:
    def test_same_company_same_req_id_merged(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            title="Software Intern",
            url="https://boards.greenhouse.io/acme/jobs/1",
            source_metadata={"requisition_id": "REQ-2026-001"},
        )
        b = _posting(
            source="workday", source_job_id="wd-99",
            title="Software Engineering Internship",
            url="https://acme.wd5.myworkdayjobs.com/jobs/REQ-2026-001",
            source_metadata={"requisition_id": "REQ-2026-001"},
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1

    def test_different_req_ids_not_merged(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            source_metadata={"requisition_id": "REQ-001"},
        )
        b = _posting(
            source="workday", source_job_id="2",
            source_metadata={"requisition_id": "REQ-002"},
        )
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_req_id_match_different_company_not_merged(self) -> None:
        a = _posting(
            source="greenhouse", company_slug="acme", source_job_id="1",
            source_metadata={"requisition_id": "REQ-001"},
        )
        b = _posting(
            source="workday", company_slug="globex", source_job_id="2",
            source_metadata={"requisition_id": "REQ-001"},
        )
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_one_has_req_id_other_does_not_not_merged_by_req(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            source_metadata={"requisition_id": "REQ-001"},
            title="Backend Engineer",
        )
        b = _posting(
            source="workday", source_job_id="2",
            source_metadata=None,
            title="Frontend Engineer",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 2


# ---------------------------------------------------------------------------
# Match hierarchy: date-constrained fuzzy match
# ---------------------------------------------------------------------------


class TestDateConstrainedFuzzyMatch:
    def test_similar_title_within_30_days_merged(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            title="Software Engineering Intern",
            posted_at="2026-09-01T00:00:00Z",
        )
        b = _posting(
            source="lever", source_job_id="2",
            title="Software Engineering Intern",
            posted_at="2026-09-15T00:00:00Z",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1

    def test_similar_title_60_days_apart_not_merged(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            title="Software Engineering Intern",
            posted_at="2026-07-01T00:00:00Z",
        )
        b = _posting(
            source="lever", source_job_id="2",
            title="Software Engineering Intern",
            posted_at="2026-09-15T00:00:00Z",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_both_none_posted_at_still_uses_fuzzy(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            title="Software Engineering Intern",
            posted_at=None,
        )
        b = _posting(
            source="lever", source_job_id="2",
            title="Software Engineering Intern",
            posted_at=None,
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1

    def test_one_none_posted_at_still_uses_fuzzy(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            title="Software Engineering Intern",
            posted_at=None,
        )
        b = _posting(
            source="lever", source_job_id="2",
            title="Software Engineering Intern",
            posted_at="2026-09-15T00:00:00Z",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Provenance tracking
# ---------------------------------------------------------------------------


class TestProvenanceTracking:
    def test_merged_posting_has_provenance(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            url="https://boards.greenhouse.io/acme/jobs/1",
        )
        b = _posting(
            source="lever", source_job_id="2",
            url="https://jobs.lever.co/acme/abc-123",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1
        provenance = result[0].source_metadata or {}
        prov_list = provenance.get("provenance", [])
        assert len(prov_list) >= 1
        sources_in_prov = {p["source"] for p in prov_list}
        assert "lever" in sources_in_prov

    def test_three_way_merge_accumulates_provenance(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1",
                     url="https://boards.greenhouse.io/acme/jobs/1")
        b = _posting(source="lever", source_job_id="2",
                     url="https://jobs.lever.co/acme/abc")
        c = _posting(source="ashby", source_job_id="3",
                     url="https://jobs.ashbyhq.com/acme/xyz")
        result = dedupe_postings([a, b, c])
        assert len(result) == 1
        provenance = (result[0].source_metadata or {}).get("provenance", [])
        sources_in_prov = {p["source"] for p in provenance}
        assert "lever" in sources_in_prov
        assert "ashby" in sources_in_prov

    def test_provenance_contains_required_fields(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="gh-1",
            url="https://boards.greenhouse.io/acme/jobs/1",
            first_seen_at="2026-08-15T00:00:00Z",
        )
        b = _posting(
            source="simplify", source_job_id="simp-1",
            url="https://boards.greenhouse.io/acme/jobs/1?utm_source=simplify",
            first_seen_at="2026-08-10T00:00:00Z",
        )
        result = dedupe_postings([a, b])
        assert len(result) == 1
        provenance = (result[0].source_metadata or {}).get("provenance", [])
        for entry in provenance:
            assert "source" in entry
            assert "source_job_id" in entry
            assert "url" in entry
            assert "discovered_at" in entry

    def test_provenance_roundtrips_through_dict(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            url="https://boards.greenhouse.io/acme/jobs/1",
        )
        b = _posting(
            source="lever", source_job_id="2",
            url="https://jobs.lever.co/acme/abc",
        )
        result = dedupe_postings([a, b])
        merged = result[0]
        d = merged.to_dict()
        restored = Posting.from_dict(d)
        assert restored.source_metadata == merged.source_metadata

    def test_unmerged_posting_has_no_provenance(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", title="SWE Intern")
        b = _posting(source="greenhouse", source_job_id="2", title="ML Intern")
        result = dedupe_postings([a, b])
        assert len(result) == 2
        for p in result:
            prov = (p.source_metadata or {}).get("provenance", [])
            assert prov == []


# ---------------------------------------------------------------------------
# Subsidiary / parent separation
# ---------------------------------------------------------------------------


class TestSubsidiarySeparation:
    def test_subsidiary_not_merged_with_parent(self) -> None:
        parent = _posting(
            source="greenhouse", company_slug="meta", source_job_id="1",
            title="Software Engineering Intern",
        )
        child = _posting(
            source="lever", company_slug="instagram", source_job_id="2",
            title="Software Engineering Intern",
        )
        result = dedupe_postings([parent, child])
        assert len(result) == 2


# ---------------------------------------------------------------------------
# SOURCE_PRIORITY registry
# ---------------------------------------------------------------------------


class TestSourcePriorityRegistry:
    def test_generic_source_registered(self) -> None:
        assert "generic" in SOURCE_PRIORITY

    def test_generic_priority_below_workday(self) -> None:
        assert SOURCE_PRIORITY["generic"] > SOURCE_PRIORITY["workday"]

    def test_generic_priority_below_simplify(self) -> None:
        assert SOURCE_PRIORITY["generic"] < SOURCE_PRIORITY["simplify"]


# ---------------------------------------------------------------------------
# Backward compatibility — existing behavior preserved
# ---------------------------------------------------------------------------


class TestBackwardCompatibility:
    def test_same_source_same_title_not_merged(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1")
        b = _posting(source="greenhouse", source_job_id="2")
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_different_titles_not_merged(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", title="Backend Engineer")
        b = _posting(source="lever", source_job_id="2", title="Frontend Engineer")
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_canonical_preference_unchanged(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        result = dedupe_postings([gh, lever])
        assert len(result) == 1
        assert result[0].source == "greenhouse"

    def test_merged_from_still_populated(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        result = dedupe_postings([gh, lever])
        assert lever.id in result[0].merged_from

    def test_first_seen_at_earliest(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1", first_seen_at=NOW)
        lever = _posting(source="lever", source_job_id="2", first_seen_at=EARLIER)
        result = dedupe_postings([gh, lever])
        assert result[0].first_seen_at == EARLIER

    def test_empty_list(self) -> None:
        assert dedupe_postings([]) == []

    def test_single_posting(self) -> None:
        p = _posting()
        result = dedupe_postings([p])
        assert result == [p]

    def test_no_location_overlap_not_merged(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1",
            location="NYC", locations=["NYC"],
        )
        b = _posting(
            source="lever", source_job_id="2",
            location="London", locations=["London"],
        )
        result = dedupe_postings([a, b])
        assert len(result) == 2
