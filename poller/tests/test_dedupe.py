from __future__ import annotations

from poller.dedupe import dedupe_postings
from poller.models import Posting, compute_posting_id

NOW = "2026-08-11T12:00:00Z"
EARLIER = "2026-08-10T08:00:00Z"


def _posting(
    source: str = "greenhouse",
    company_slug: str = "acme",
    source_job_id: str = "100",
    title: str = "Software Engineering Intern",
    location: str = "New York, NY",
    locations: list[str] | None = None,
    first_seen_at: str = NOW,
    last_seen_at: str = NOW,
) -> Posting:
    posting_id = compute_posting_id(source, company_slug, source_job_id)
    return Posting(
        id=posting_id,
        company="Acme Corp",
        company_slug=company_slug,
        title=title,
        location=location,
        locations=locations if locations is not None else [location] if location else [],
        url=f"https://example.com/jobs/{source_job_id}",
        source=source,
        source_job_id=source_job_id,
        ats=source,
        posted_at=None,
        first_seen_at=first_seen_at,
        last_seen_at=last_seen_at,
    )


class TestTrueDuplicate:
    def test_same_title_different_source_merged(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        result = dedupe_postings([gh, lever])
        assert len(result) == 1

    def test_canonical_is_greenhouse(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        result = dedupe_postings([gh, lever])
        assert result[0].source == "greenhouse"

    def test_merged_from_populated(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        result = dedupe_postings([gh, lever])
        assert lever.id in result[0].merged_from

    def test_first_seen_at_is_earliest(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1", first_seen_at=NOW)
        lever = _posting(source="lever", source_job_id="2", first_seen_at=EARLIER)
        result = dedupe_postings([gh, lever])
        assert result[0].first_seen_at == EARLIER

    def test_first_seen_at_earliest_regardless_of_order(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1", first_seen_at=EARLIER)
        lever = _posting(source="lever", source_job_id="2", first_seen_at=NOW)
        result = dedupe_postings([gh, lever])
        assert result[0].first_seen_at == EARLIER


class TestNearMiss:
    def test_different_titles_not_merged(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", title="Backend Engineer")
        b = _posting(source="lever", source_job_id="2", title="Frontend Engineer")
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_similar_but_below_threshold(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", title="Software Engineer Intern")
        b = _posting(source="lever", source_job_id="2", title="Software Engineer Full-Time")
        result = dedupe_postings([a, b])
        assert len(result) == 2


class TestDifferentCompany:
    def test_same_title_different_company_not_merged(self) -> None:
        a = _posting(source="greenhouse", company_slug="acme", source_job_id="1")
        b = _posting(source="lever", company_slug="globex", source_job_id="2")
        result = dedupe_postings([a, b])
        assert len(result) == 2


class TestCanonicalPreference:
    def test_ashby_vs_greenhouse_greenhouse_wins(self) -> None:
        ashby = _posting(source="ashby", source_job_id="1")
        gh = _posting(source="greenhouse", source_job_id="2")
        result = dedupe_postings([ashby, gh])
        assert len(result) == 1
        assert result[0].source == "greenhouse"
        assert ashby.id in result[0].merged_from

    def test_lever_vs_ashby_lever_wins(self) -> None:
        ashby = _posting(source="ashby", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        result = dedupe_postings([ashby, lever])
        assert len(result) == 1
        assert result[0].source == "lever"

    def test_unknown_source_vs_greenhouse(self) -> None:
        unknown = _posting(source="simplify", source_job_id="1")
        gh = _posting(source="greenhouse", source_job_id="2")
        result = dedupe_postings([unknown, gh])
        assert len(result) == 1
        assert result[0].source == "greenhouse"


class TestSingleSource:
    def test_all_postings_pass_through(self) -> None:
        postings = [
            _posting(source="greenhouse", source_job_id="1", title="SWE Intern"),
            _posting(source="greenhouse", source_job_id="2", title="ML Intern"),
            _posting(source="greenhouse", source_job_id="3", title="Data Intern"),
        ]
        result = dedupe_postings(postings)
        assert len(result) == 3

    def test_same_source_same_title_not_merged(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1")
        b = _posting(source="greenhouse", source_job_id="2")
        result = dedupe_postings([a, b])
        assert len(result) == 2


class TestLocationOverlap:
    def test_both_empty_location_matches(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", location="", locations=[])
        b = _posting(source="lever", source_job_id="2", location="", locations=[])
        result = dedupe_postings([a, b])
        assert len(result) == 1

    def test_overlapping_location_matches(self) -> None:
        a = _posting(
            source="greenhouse", source_job_id="1", location="NYC", locations=["NYC", "SF"],
        )
        b = _posting(source="lever", source_job_id="2", location="NYC", locations=["NYC"])
        result = dedupe_postings([a, b])
        assert len(result) == 1

    def test_no_location_overlap_not_merged(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", location="NYC", locations=["NYC"])
        b = _posting(source="lever", source_job_id="2", location="London", locations=["London"])
        result = dedupe_postings([a, b])
        assert len(result) == 2

    def test_one_empty_one_filled_not_merged(self) -> None:
        a = _posting(source="greenhouse", source_job_id="1", location="", locations=[])
        b = _posting(source="lever", source_job_id="2", location="NYC", locations=["NYC"])
        result = dedupe_postings([a, b])
        assert len(result) == 2


class TestEmptyAndEdgeCases:
    def test_empty_list(self) -> None:
        assert dedupe_postings([]) == []

    def test_single_posting(self) -> None:
        p = _posting()
        result = dedupe_postings([p])
        assert result == [p]

    def test_multiple_companies_independent(self) -> None:
        a1 = _posting(source="greenhouse", company_slug="acme", source_job_id="1")
        a2 = _posting(source="lever", company_slug="acme", source_job_id="2")
        b1 = _posting(
            source="greenhouse", company_slug="globex", source_job_id="3", title="Backend Engineer",
        )
        result = dedupe_postings([a1, a2, b1])
        assert len(result) == 2
        slugs = {p.company_slug for p in result}
        assert "acme" in slugs
        assert "globex" in slugs

    def test_three_way_merge(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1", first_seen_at=NOW)
        lever = _posting(source="lever", source_job_id="2", first_seen_at=EARLIER)
        ashby = _posting(source="ashby", source_job_id="3", first_seen_at=NOW)
        result = dedupe_postings([gh, lever, ashby])
        assert len(result) == 1
        assert result[0].source == "greenhouse"
        assert result[0].first_seen_at == EARLIER
        assert len(result[0].merged_from) == 2


class TestMergedFromAccumulation:
    def test_merged_from_contains_all_discarded_ids(self) -> None:
        gh = _posting(source="greenhouse", source_job_id="1")
        lever = _posting(source="lever", source_job_id="2")
        ashby = _posting(source="ashby", source_job_id="3")
        result = dedupe_postings([gh, lever, ashby])
        assert len(result) == 1
        assert lever.id in result[0].merged_from
        assert ashby.id in result[0].merged_from
