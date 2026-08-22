"""Phase 2.5 — Registry expansion validation tests.

Verifies the expanded registry loads correctly with all 5 ATS types,
meets the 200+ company target, and maintains data integrity.
"""

from __future__ import annotations

from poller.registry import load_registry

VALID_SOURCE_TYPES = {"greenhouse", "lever", "ashby", "workday", "smartrecruiters"}


class TestRegistryPhase25:
    def test_company_count_at_least_200(self) -> None:
        companies = load_registry()
        assert len(companies) >= 200, f"Expected >= 200, got {len(companies)}"

    def test_all_slugs_unique(self) -> None:
        companies = load_registry()
        slugs = [c.slug for c in companies]
        assert len(slugs) == len(set(slugs)), (
            f"Duplicate slugs found: "
            f"{[s for s in slugs if slugs.count(s) > 1]}"
        )

    def test_all_board_tokens_non_empty(self) -> None:
        companies = load_registry()
        for c in companies:
            for src in c.sources:
                assert src.board_token, (
                    f"{c.slug}: source type={src.type} has empty board_token"
                )

    def test_all_source_types_valid(self) -> None:
        companies = load_registry()
        for c in companies:
            for src in c.sources:
                assert src.type in VALID_SOURCE_TYPES, (
                    f"{c.slug}: unknown source type '{src.type}'"
                )

    def test_workday_sources_present(self) -> None:
        companies = load_registry()
        workday = [c for c in companies if any(s.type == "workday" for s in c.sources)]
        assert len(workday) >= 1, "No Workday companies in registry"

    def test_smartrecruiters_sources_present(self) -> None:
        companies = load_registry()
        sr = [
            c for c in companies
            if any(s.type == "smartrecruiters" for s in c.sources)
        ]
        assert len(sr) >= 1, "No SmartRecruiters companies in registry"

    def test_at_least_five_ats_types_represented(self) -> None:
        companies = load_registry()
        types_seen: set[str] = set()
        for c in companies:
            for src in c.sources:
                types_seen.add(src.type)
        assert len(types_seen) >= 5, (
            f"Expected >= 5 ATS types, got {len(types_seen)}: {types_seen}"
        )

    def test_all_companies_have_name_and_tags(self) -> None:
        companies = load_registry()
        for c in companies:
            assert c.name, f"{c.slug}: missing name"
            assert isinstance(c.tags, list), f"{c.slug}: tags is not a list"

    def test_workday_board_tokens_contain_host(self) -> None:
        companies = load_registry()
        for c in companies:
            for src in c.sources:
                if src.type == "workday":
                    assert "myworkdayjobs.com" in src.board_token, (
                        f"{c.slug}: Workday board_token missing host: "
                        f"{src.board_token}"
                    )

    def test_high_priority_companies_exist(self) -> None:
        companies = load_registry()
        hp = [c.slug for c in companies if c.high_priority]
        assert len(hp) >= 5, f"Expected >= 5 high_priority, got {len(hp)}: {hp}"
        for expected in ["nvidia", "capital-one", "jane-street", "spacex"]:
            assert expected in hp, f"{expected} should be high_priority"

    def test_ats_distribution_breadth(self) -> None:
        companies = load_registry()
        from collections import Counter

        counts: Counter[str] = Counter()
        for c in companies:
            for src in c.sources:
                counts[src.type] += 1
        assert counts["greenhouse"] >= 40
        assert counts["workday"] >= 20
        assert counts["ashby"] >= 20
        assert counts["lever"] >= 5
        assert counts["smartrecruiters"] >= 5

    def test_every_company_has_at_least_two_tags(self) -> None:
        companies = load_registry()
        for c in companies:
            assert len(c.tags) >= 2, (
                f"{c.slug}: only {len(c.tags)} tag(s): {c.tags}"
            )

    def test_block6_key_companies_present(self) -> None:
        companies = load_registry()
        slugs = {c.slug for c in companies}
        block6_samples = [
            "neuralink", "point72", "drw", "figure", "zoox",
            "applied-intuition", "etched", "tenstorrent",
            "palo-alto-networks", "northrop-grumman", "blackstone",
        ]
        for slug in block6_samples:
            assert slug in slugs, f"Block 6 company '{slug}' missing from registry"
