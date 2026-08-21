from typing import Any

from poller.models import Posting, compute_posting_id


def _make_posting(**overrides: Any) -> Posting:
    defaults: dict[str, Any] = {
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
        "source_metadata": None,
    }
    defaults.update(overrides)
    return Posting(**defaults)


class TestSourceMetadataRoundTrip:
    def test_with_metadata_round_trip(self) -> None:
        meta = {
            "sponsorship": "Offers Sponsorship",
            "terms": ["Summer 2027"],
            "degrees": ["Bachelor's"],
            "category": "Software Engineering",
        }
        posting = _make_posting(source_metadata=meta)
        d = posting.to_dict()
        assert d["source_metadata"] == meta
        restored = Posting.from_dict(d)
        assert restored.source_metadata == meta
        assert restored == posting

    def test_without_metadata_no_key_in_dict(self) -> None:
        posting = _make_posting(source_metadata=None)
        d = posting.to_dict()
        assert "source_metadata" not in d

    def test_without_metadata_from_dict_returns_none(self) -> None:
        posting = _make_posting(source_metadata=None)
        d = posting.to_dict()
        restored = Posting.from_dict(d)
        assert restored.source_metadata is None
        assert restored == posting

    def test_empty_dict_metadata_preserved(self) -> None:
        posting = _make_posting(source_metadata={})
        d = posting.to_dict()
        assert d["source_metadata"] == {}
        restored = Posting.from_dict(d)
        assert restored.source_metadata == {}

    def test_nested_metadata_preserved(self) -> None:
        meta = {
            "sponsorship": "Doesn't Offer Sponsorship",
            "terms": ["Summer 2027", "Fall 2026"],
            "extra": {"nested_key": [1, 2, 3]},
        }
        posting = _make_posting(source_metadata=meta)
        d = posting.to_dict()
        restored = Posting.from_dict(d)
        assert restored.source_metadata == meta

    def test_metadata_does_not_affect_id(self) -> None:
        p1 = _make_posting(source_metadata=None)
        p2 = _make_posting(source_metadata={"sponsorship": "test"})
        assert p1.id == p2.id

    def test_existing_fields_unchanged_with_metadata(self) -> None:
        meta = {"sponsorship": "Offers Sponsorship"}
        posting = _make_posting(source_metadata=meta, compensation="$50/hr")
        d = posting.to_dict()
        assert d["compensation"] == "$50/hr"
        assert d["source_metadata"] == meta
        assert "description_text" not in d
        restored = Posting.from_dict(d)
        assert restored.compensation == "$50/hr"
        assert restored.source_metadata == meta

    def test_metadata_dict_is_copied_not_shared(self) -> None:
        meta = {"sponsorship": "test"}
        posting = _make_posting(source_metadata=meta)
        d = posting.to_dict()
        d["source_metadata"]["sponsorship"] = "mutated"
        assert posting.source_metadata is not None
        assert posting.source_metadata["sponsorship"] == "test"
