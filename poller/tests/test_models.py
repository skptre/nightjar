import hashlib
from typing import Any

from poller.models import (
    Company,
    Posting,
    SourceConfig,
    SourceHealth,
    compute_posting_id,
)


class TestPostingId:
    def test_deterministic_same_input_same_hash(self) -> None:
        id1 = compute_posting_id("greenhouse", "ramp", "12345")
        id2 = compute_posting_id("greenhouse", "ramp", "12345")
        assert id1 == id2

    def test_matches_raw_sha256(self) -> None:
        raw = "greenhouse:ramp:12345"
        expected = hashlib.sha256(raw.encode()).hexdigest()[:16]
        assert compute_posting_id("greenhouse", "ramp", "12345") == expected

    def test_length_is_16(self) -> None:
        result = compute_posting_id("lever", "cloudflare", "abc-123")
        assert len(result) == 16

    def test_hex_characters_only(self) -> None:
        result = compute_posting_id("ashby", "linear", "job_999")
        assert all(c in "0123456789abcdef" for c in result)

    def test_different_source_different_id(self) -> None:
        id1 = compute_posting_id("greenhouse", "ramp", "12345")
        id2 = compute_posting_id("lever", "ramp", "12345")
        assert id1 != id2

    def test_different_company_different_id(self) -> None:
        id1 = compute_posting_id("greenhouse", "ramp", "12345")
        id2 = compute_posting_id("greenhouse", "stripe", "12345")
        assert id1 != id2

    def test_different_job_id_different_id(self) -> None:
        id1 = compute_posting_id("greenhouse", "ramp", "12345")
        id2 = compute_posting_id("greenhouse", "ramp", "67890")
        assert id1 != id2

    def test_title_changes_do_not_affect_id(self) -> None:
        id1 = compute_posting_id("greenhouse", "ramp", "12345")
        id2 = compute_posting_id("greenhouse", "ramp", "12345")
        assert id1 == id2
        assert "SWE Intern" not in id1
        assert "Senior Engineer" not in id1

    def test_url_changes_do_not_affect_id(self) -> None:
        id1 = compute_posting_id("greenhouse", "ramp", "12345")
        assert "greenhouse.io" not in id1
        assert "boards" not in id1


class TestPostingRoundTrip:
    def _make_posting(self, **overrides: Any) -> Posting:
        defaults = {
            "id": compute_posting_id("greenhouse", "ramp", "12345"),
            "company": "Ramp",
            "company_slug": "ramp",
            "title": "Software Engineering Intern",
            "location": "New York, NY",
            "locations": ["New York, NY"],
            "url": "https://boards.greenhouse.io/ramp/jobs/12345",
            "source": "greenhouse",
            "source_job_id": "12345",
            "ats": "greenhouse",
            "posted_at": "2026-09-15T00:00:00Z",
            "first_seen_at": "2026-09-15T08:33:00Z",
            "last_seen_at": "2026-10-01T12:18:00Z",
            "description_text": "",
            "closed_at": None,
            "compensation": None,
            "merged_from": [],
        }
        defaults.update(overrides)
        return Posting(**defaults)  # type: ignore[arg-type]

    def test_to_dict_and_back(self) -> None:
        original = self._make_posting()
        d = original.to_dict()
        restored = Posting.from_dict(d)
        assert restored == original

    def test_round_trip_with_closed_at(self) -> None:
        original = self._make_posting(closed_at="2026-10-05T00:00:00Z")
        d = original.to_dict()
        restored = Posting.from_dict(d)
        assert restored == original
        assert restored.closed_at == "2026-10-05T00:00:00Z"

    def test_round_trip_with_compensation(self) -> None:
        original = self._make_posting(compensation="$120k-$180k/yr")
        d = original.to_dict()
        assert d["compensation"] == "$120k-$180k/yr"
        restored = Posting.from_dict(d)
        assert restored == original

    def test_round_trip_with_merged_from(self) -> None:
        original = self._make_posting(merged_from=["abc123", "def456"])
        d = original.to_dict()
        assert d["merged_from"] == ["abc123", "def456"]
        restored = Posting.from_dict(d)
        assert restored == original

    def test_compensation_omitted_when_none(self) -> None:
        posting = self._make_posting(compensation=None)
        d = posting.to_dict()
        assert "compensation" not in d

    def test_merged_from_omitted_when_empty(self) -> None:
        posting = self._make_posting(merged_from=[])
        d = posting.to_dict()
        assert "merged_from" not in d

    def test_description_text_excluded_from_dict(self) -> None:
        posting = self._make_posting()
        d = posting.to_dict()
        assert "description_text" not in d

    def test_posting_is_frozen(self) -> None:
        posting = self._make_posting()
        try:
            posting.title = "Changed"  # type: ignore[misc]
            raise AssertionError("Should not allow mutation")
        except AttributeError:
            pass

    def test_multiple_locations(self) -> None:
        original = self._make_posting(
            locations=["New York, NY", "San Francisco, CA", "Remote"]
        )
        d = original.to_dict()
        assert d["locations"] == ["New York, NY", "San Francisco, CA", "Remote"]
        restored = Posting.from_dict(d)
        assert restored.locations == ["New York, NY", "San Francisco, CA", "Remote"]

    def test_null_posted_at(self) -> None:
        original = self._make_posting(posted_at=None)
        d = original.to_dict()
        assert d["posted_at"] is None
        restored = Posting.from_dict(d)
        assert restored.posted_at is None

    def test_from_dict_missing_optional_fields(self) -> None:
        d = {
            "id": "abc123",
            "company": "Ramp",
            "company_slug": "ramp",
            "title": "SWE Intern",
            "location": "NYC",
            "locations": ["NYC"],
            "url": "https://example.com",
            "source": "greenhouse",
            "source_job_id": "12345",
            "ats": "greenhouse",
            "first_seen_at": "2026-09-15T08:33:00Z",
            "last_seen_at": "2026-10-01T12:18:00Z",
        }
        posting = Posting.from_dict(d)
        assert posting.posted_at is None
        assert posting.closed_at is None
        assert posting.compensation is None
        assert posting.merged_from == []


class TestSourceConfig:
    def test_eu_defaults_false(self) -> None:
        config = SourceConfig(type="lever", board_token="cloudflare")
        assert config.eu is False

    def test_eu_set_true(self) -> None:
        config = SourceConfig(type="lever", board_token="some-eu-company", eu=True)
        assert config.eu is True

    def test_fields_stored(self) -> None:
        config = SourceConfig(type="greenhouse", board_token="ramp")
        assert config.type == "greenhouse"
        assert config.board_token == "ramp"


class TestCompany:
    def test_defaults(self) -> None:
        company = Company(
            slug="ramp",
            name="Ramp",
            tags=["fintech"],
            sources=[SourceConfig(type="greenhouse", board_token="ramp")],
        )
        assert company.typical_open is None
        assert company.high_priority is False

    def test_with_all_fields(self) -> None:
        company = Company(
            slug="ramp",
            name="Ramp",
            tags=["fintech", "nyc"],
            sources=[SourceConfig(type="greenhouse", board_token="ramp")],
            typical_open="2026-09",
            high_priority=True,
        )
        assert company.typical_open == "2026-09"
        assert company.high_priority is True
        assert len(company.sources) == 1

    def test_multiple_sources(self) -> None:
        company = Company(
            slug="example",
            name="Example Corp",
            tags=[],
            sources=[
                SourceConfig(type="greenhouse", board_token="example"),
                SourceConfig(type="lever", board_token="example-co"),
            ],
        )
        assert len(company.sources) == 2
        assert company.sources[0].type == "greenhouse"
        assert company.sources[1].type == "lever"


class TestSourceHealth:
    def test_defaults(self) -> None:
        health = SourceHealth()
        assert health.last_polled_at is None
        assert health.healthy is True
        assert health.error is None
        assert health.bootstrapped is False
        assert health.potentially_truncated is False

    def test_unhealthy_with_error(self) -> None:
        health = SourceHealth(
            healthy=False,
            error="HTTP 500: Internal Server Error",
        )
        assert health.healthy is False
        assert health.error == "HTTP 500: Internal Server Error"

    def test_bootstrapped_and_truncated(self) -> None:
        health = SourceHealth(
            bootstrapped=True,
            potentially_truncated=True,
        )
        assert health.bootstrapped is True
        assert health.potentially_truncated is True
