from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import httpx
import pytest

from poller.dedupe import SOURCE_PRIORITY
from poller.exceptions import SourceFetchError
from poller.http import RateLimitedClient
from poller.models import Company, SourceConfig, compute_posting_id
from poller.registry import VALID_SOURCE_TYPES
from poller.sources import ADAPTERS, get_adapter
from poller.sources.generic import (
    MAX_COMPANY_REQUESTS,
    GenericAdapter,
    RobotsPolicy,
    extract_html_heuristic,
    extract_hydration,
    extract_json_ld,
    parse_feed,
    parse_sitemap,
)
from poller.tests.conftest import MockTransport, make_mock_client

if TYPE_CHECKING:
    from collections.abc import Mapping

FIXTURES = Path(__file__).parent / "fixtures" / "generic"
BASE = "https://careers.example.com/careers"
ORIGIN = "https://careers.example.com"
NOW = "2026-09-02T12:00:00Z"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _company(board_token: str = BASE) -> Company:
    return Company(
        slug="example",
        name="Example Corp",
        tags=["tech"],
        sources=[SourceConfig(type="generic", board_token=board_token)],
    )


class URLMapClient(RateLimitedClient):
    def __init__(self, responses: Mapping[str, str | Exception]) -> None:
        self.responses = dict(responses)
        self.calls: list[tuple[str, str, str]] = []

    async def get_text(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        follow_redirects: bool = True,
    ) -> str:
        del params, follow_redirects
        self.calls.append((url, source, company_slug))
        result = self.responses.get(url)
        if result is None:
            raise SourceFetchError(source, company_slug, "HTTP 404: missing fixture")
        if isinstance(result, Exception):
            raise result
        return result


class TestRobotsPolicy:
    def test_specific_agent_group_wins_over_wildcard(self) -> None:
        policy = RobotsPolicy.parse(_fixture("robots_disallow.txt"))

        assert not policy.can_fetch("nightjar", f"{ORIGIN}/careers/role")
        assert policy.can_fetch("otherbot", f"{ORIGIN}/careers/role")

    def test_longest_rule_wins_and_allow_wins_tie(self) -> None:
        policy = RobotsPolicy.parse(
            "User-agent: *\nDisallow: /jobs/\nAllow: /jobs/public/\nDisallow: /same\nAllow: /same\n"
        )

        assert not policy.can_fetch("nightjar", f"{ORIGIN}/jobs/private/1")
        assert policy.can_fetch("nightjar", f"{ORIGIN}/jobs/public/1")
        assert policy.can_fetch("nightjar", f"{ORIGIN}/same")

    def test_wildcard_and_end_anchor_are_supported(self) -> None:
        policy = RobotsPolicy.parse("User-agent: *\nDisallow: /*.pdf$\n")

        assert not policy.can_fetch("nightjar", f"{ORIGIN}/jobs/spec.pdf")
        assert policy.can_fetch("nightjar", f"{ORIGIN}/jobs/spec.pdf?download=1")

    def test_sitemap_directives_are_extracted(self) -> None:
        policy = RobotsPolicy.parse(_fixture("robots_allow.txt"))

        assert policy.sitemaps == [f"{ORIGIN}/sitemap-index.xml"]


class TestStructuredParsers:
    def test_sitemap_index_and_urlset_preserve_lastmod(self) -> None:
        index = parse_sitemap(_fixture("sitemap_index.xml"))
        urlset = parse_sitemap(_fixture("jobs_sitemap.xml"))

        assert index.kind == "index"
        assert index.entries[0].url == f"{ORIGIN}/jobs-sitemap.xml"
        assert index.entries[0].last_modified == "2026-09-01"
        assert urlset.kind == "urlset"
        assert len(urlset.entries) == 3
        assert urlset.entries[1].last_modified == "2026-08-29T12:00:00Z"

    def test_xml_doctype_is_rejected(self) -> None:
        unsafe = '<!DOCTYPE x [<!ENTITY y "boom">]><urlset>&y;</urlset>'

        with pytest.raises(ValueError, match="unsafe XML"):
            parse_sitemap(unsafe)

    def test_rss_feed_extracts_five_stable_postings(self) -> None:
        postings = parse_feed(_fixture("jobs.rss"), "example", BASE)

        assert len(postings) == 5
        assert postings[0].source_job_id == "rss-1"
        assert postings[0].posted_at == "2026-08-31T15:00:00Z"
        assert postings[0].description == "First role"
        assert postings[0].raw_data["extraction_method"] == "rss"

    def test_atom_feed_uses_atom_id_and_alternate_link(self) -> None:
        postings = parse_feed(_fixture("jobs.atom"), "example", BASE)

        assert len(postings) == 1
        assert postings[0].source_job_id == "tag:example.com,2026:security-1"
        assert postings[0].url == f"{ORIGIN}/jobs/security-1"
        assert postings[0].posted_at == "2026-09-01T17:00:00Z"

    def test_malformed_feed_is_not_an_empty_board(self) -> None:
        with pytest.raises(ValueError):
            parse_feed("<rss><channel><item>", "example", BASE)

    def test_feed_item_schema_drift_is_not_an_empty_board(self) -> None:
        malformed_item = (
            "<rss><channel><item><guid>1</guid><title>Missing link</title></item></channel></rss>"
        )

        with pytest.raises(ValueError, match="malformed RSS item"):
            parse_feed(malformed_item, "example", BASE)

    def test_sitemap_entry_schema_drift_is_not_an_empty_board(self) -> None:
        with pytest.raises(ValueError, match="missing loc"):
            parse_sitemap("<urlset><url><lastmod>2026-09-01</lastmod></url></urlset>")


class TestPageExtraction:
    def test_json_ld_full_schema_fields(self) -> None:
        postings = extract_json_ld(_fixture("job_jsonld_full.html"), "example", BASE)

        assert len(postings) == 1
        raw = postings[0]
        assert raw.source_job_id == "ENG-101"
        assert raw.title == "Software Engineering Intern"
        assert raw.locations == ["New York, NY, US", "Boston, MA, US", "Remote"]
        assert raw.posted_at == "2026-08-20"
        assert raw.valid_through == "2026-10-01T23:59:59Z"
        assert raw.employment_type == "INTERN, FULL_TIME"
        assert raw.workplace_type == "Remote"
        assert raw.compensation == "USD 30-42 per HOUR"
        assert raw.education_requirements == "Enrolled in a degree program"
        assert raw.experience_requirements == "No prior experience required"
        assert raw.occupational_category == "15-1252 Software Developers"
        assert raw.raw_data["hiring_organization"] == "Example Labs"
        assert raw.raw_data["direct_apply"] is True
        assert raw.raw_data["applicant_location_requirements"] == "United States"
        assert raw.raw_data["extraction_method"] == "json_ld"

    def test_json_ld_graph_and_missing_optional_fields(self) -> None:
        postings = extract_json_ld(_fixture("job_jsonld_minimal.html"), "example", BASE)

        assert len(postings) == 1
        raw = postings[0]
        assert raw.source_job_id == "DATA-102"
        assert raw.location == ""
        assert raw.description == ""
        assert raw.posted_at is None
        assert raw.compensation is None

    def test_invalid_json_ld_block_does_not_hide_a_valid_block(self) -> None:
        html = (
            '<script type="application/ld+json">{bad</script>'
            '<script type="application/ld+json">'
            '{"@type":"JobPosting","title":"Valid Intern","identifier":"V-1"}'
            "</script>"
        )

        postings = extract_json_ld(html, "example", f"{ORIGIN}/jobs/v-1")

        assert [posting.source_job_id for posting in postings] == ["V-1"]

    def test_json_ld_without_identifier_uses_url_but_not_requisition_id(self) -> None:
        html = (
            '<script type="application/ld+json">'
            '{"@type":"JobPosting","title":"URL Intern",'
            '"url":"https://careers.example.com/jobs/url-intern"}'
            "</script>"
        )

        raw = extract_json_ld(html, "example", BASE)[0]
        posting = GenericAdapter().normalize(raw, _company(), NOW)

        assert raw.source_job_id == f"{ORIGIN}/jobs/url-intern"
        assert raw.requisition_id is None
        assert posting.source_metadata is not None
        assert "requisition_id" not in posting.source_metadata

    @pytest.mark.parametrize("fixture_name", ["next_data.html", "initial_state.html"])
    def test_static_hydration_is_extracted(self, fixture_name: str) -> None:
        postings = extract_hydration(_fixture(fixture_name), "example", BASE)

        assert len(postings) == 1
        assert postings[0].title
        assert postings[0].source_job_id in {"NEXT-201", "STATE-301"}
        assert postings[0].raw_data["extraction_method"] == "hydration"

    def test_semantic_html_is_quarantined(self) -> None:
        candidates = extract_html_heuristic(
            _fixture("html_heuristic.html"), "example", f"{ORIGIN}/jobs/ops-1"
        )

        assert len(candidates) == 1
        assert candidates[0].extraction_confidence == "low"
        assert candidates[0].review_required is True
        assert candidates[0].extraction_method == "html_heuristic"

    def test_semantic_html_requires_job_like_url(self) -> None:
        assert (
            extract_html_heuristic(_fixture("html_heuristic.html"), "example", f"{ORIGIN}/about")
            == []
        )


class TestGenericFetch:
    @pytest.mark.asyncio
    async def test_sitemap_three_job_pages_produce_three_postings(self) -> None:
        minimal = _fixture("job_jsonld_minimal.html")
        page_103 = (
            minimal.replace("DATA-102", "OPS-103")
            .replace("Data Intern", "Operations Intern")
            .replace("/jobs/102", "/careers/103")
        )
        responses = {
            f"{ORIGIN}/robots.txt": _fixture("robots_allow.txt"),
            BASE: "<html><head></head><body>Careers</body></html>",
            f"{ORIGIN}/sitemap-index.xml": _fixture("sitemap_index.xml"),
            f"{ORIGIN}/jobs-sitemap.xml": _fixture("jobs_sitemap.xml"),
            f"{ORIGIN}/jobs/101": _fixture("job_jsonld_full.html"),
            f"{ORIGIN}/jobs/102": minimal,
            f"{ORIGIN}/careers/103": page_103,
        }
        client = URLMapClient(responses)
        adapter = GenericAdapter()

        postings = await adapter.fetch(client, _company(), _company().sources[0])

        assert len(postings) == 3
        assert {posting.source_job_id for posting in postings} == {
            "ENG-101",
            "DATA-102",
            "OPS-103",
        }
        assert all(call[1:] == ("generic", "example") for call in client.calls)
        assert adapter.extraction_status == "supported"

    @pytest.mark.asyncio
    async def test_rss_feed_produces_five_postings(self) -> None:
        page = (
            '<html><head><link rel="alternate" type="application/rss+xml" '
            'href="/jobs.rss"></head></html>'
        )
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": "User-agent: *\nAllow: /\n",
                BASE: page,
                f"{ORIGIN}/jobs.rss": _fixture("jobs.rss"),
            }
        )
        adapter = GenericAdapter()

        postings = await adapter.fetch(client, _company(), _company().sources[0])

        assert len(postings) == 5
        assert {posting.raw_data["extraction_method"] for posting in postings} == {"rss"}

    @pytest.mark.asyncio
    async def test_rss_feed_declared_in_robots_is_parsed(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": (f"User-agent: *\nAllow: /\nSitemap: {ORIGIN}/jobs.rss\n"),
                BASE: "<html><body>Careers</body></html>",
                f"{ORIGIN}/jobs.rss": _fixture("jobs.rss"),
            }
        )

        postings = await GenericAdapter().fetch(
            client,
            _company(),
            _company().sources[0],
        )

        assert len(postings) == 5
        assert {posting.raw_data["extraction_method"] for posting in postings} == {"rss"}

    @pytest.mark.asyncio
    async def test_valid_empty_feed_returns_empty_list(self) -> None:
        page = '<link rel="alternate" type="application/rss+xml" href="/empty.xml">'
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": "User-agent: *\nAllow: /\n",
                BASE: page,
                f"{ORIGIN}/empty.xml": _fixture("empty_feed.xml"),
            }
        )

        result = await GenericAdapter().fetch(
            client,
            _company(),
            _company().sources[0],
        )

        assert result == []

    @pytest.mark.asyncio
    async def test_robots_disallow_blocks_all_non_robots_requests(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": _fixture("robots_disallow.txt"),
            }
        )
        adapter = GenericAdapter()

        with pytest.raises(SourceFetchError, match="blocked by robots.txt"):
            await adapter.fetch(client, _company(), _company().sources[0])

        assert [call[0] for call in client.calls] == [f"{ORIGIN}/robots.txt"]
        assert adapter.extraction_status == "blocked"

    @pytest.mark.asyncio
    async def test_robots_404_is_unavailable_and_allows_access(self) -> None:
        page = '<link rel="alternate" type="application/rss+xml" href="/empty.xml">'
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": SourceFetchError("generic", "example", "HTTP 404: missing"),
                BASE: page,
                f"{ORIGIN}/empty.xml": _fixture("empty_feed.xml"),
            }
        )

        result = await GenericAdapter().fetch(
            client,
            _company(),
            _company().sources[0],
        )

        assert result == []

    @pytest.mark.asyncio
    async def test_robots_500_is_unreachable_and_fails_closed(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": SourceFetchError(
                    "generic", "example", "HTTP 500 after 3 attempts"
                ),
            }
        )

        with pytest.raises(SourceFetchError, match="robots.txt unreachable"):
            await GenericAdapter().fetch(
                client,
                _company(),
                _company().sources[0],
            )

        assert len(client.calls) == 1

    @pytest.mark.asyncio
    async def test_redirect_target_is_robots_checked_before_request(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": "User-agent: *\nDisallow: /private/\n",
                BASE: SourceFetchError("generic", "example", "redirect 302: /private/careers"),
            }
        )
        adapter = GenericAdapter()

        with pytest.raises(SourceFetchError, match="blocked by robots.txt"):
            await adapter.fetch(client, _company(), _company().sources[0])

        assert [call[0] for call in client.calls] == [f"{ORIGIN}/robots.txt", BASE]
        assert adapter.extraction_status == "blocked"

    @pytest.mark.asyncio
    async def test_real_http_client_does_not_auto_follow_generic_redirects(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        transport = MockTransport(
            [
                httpx.Response(
                    200,
                    headers={"content-type": "text/plain"},
                    text="User-agent: *\nDisallow: /private/\n",
                ),
                httpx.Response(302, headers={"Location": "/private/careers"}),
            ]
        )
        client = await make_mock_client(transport)

        async def no_delay(host: str) -> None:
            del host

        monkeypatch.setattr(client, "_enforce_host_delay", no_delay)
        adapter = GenericAdapter()

        with pytest.raises(SourceFetchError, match="blocked by robots.txt"):
            await adapter.fetch(client, _company(), _company().sources[0])

        assert len(transport.requests) == 2
        await client.close()

    @pytest.mark.asyncio
    async def test_captcha_is_blocked_not_empty(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": "User-agent: *\nAllow: /\n",
                BASE: _fixture("captcha.html"),
            }
        )
        adapter = GenericAdapter()

        with pytest.raises(SourceFetchError, match="anti-bot challenge"):
            await adapter.fetch(client, _company(), _company().sources[0])

        assert adapter.extraction_status == "blocked"

    @pytest.mark.asyncio
    async def test_only_html_heuristic_is_quarantined_and_not_published(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": "User-agent: *\nAllow: /\n",
                BASE: _fixture("html_heuristic.html"),
            }
        )
        adapter = GenericAdapter()

        with pytest.raises(SourceFetchError, match="only low-confidence"):
            await adapter.fetch(client, _company(), _company().sources[0])

        assert len(adapter.quarantined_results) == 1
        assert adapter.extraction_status == "unsupported"

    @pytest.mark.asyncio
    async def test_no_strategy_is_unsupported_not_empty(self) -> None:
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": "User-agent: *\nAllow: /\n",
                BASE: "<html><body>Company information</body></html>",
            }
        )

        with pytest.raises(SourceFetchError, match="unsupported"):
            await GenericAdapter().fetch(
                client,
                _company(),
                _company().sources[0],
            )

    @pytest.mark.asyncio
    async def test_cross_host_sitemap_targets_are_never_requested(self) -> None:
        robots = "User-agent: *\nSitemap: https://evil.example.net/jobs.xml\n"
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": robots,
                BASE: '<link rel="alternate" type="application/rss+xml" href="/empty.xml">',
                f"{ORIGIN}/empty.xml": _fixture("empty_feed.xml"),
            }
        )

        await GenericAdapter().fetch(
            client,
            _company(),
            _company().sources[0],
        )

        assert all("evil.example.net" not in call[0] for call in client.calls)

    @pytest.mark.asyncio
    async def test_stale_404_job_page_does_not_discard_other_sitemap_jobs(self) -> None:
        sitemap = (
            "<urlset>"
            f"<url><loc>{ORIGIN}/jobs/101</loc></url>"
            f"<url><loc>{ORIGIN}/jobs/stale</loc></url>"
            "</urlset>"
        )
        client = URLMapClient(
            {
                f"{ORIGIN}/robots.txt": (f"User-agent: *\nAllow: /\nSitemap: {ORIGIN}/jobs.xml\n"),
                BASE: "<html></html>",
                f"{ORIGIN}/jobs.xml": sitemap,
                f"{ORIGIN}/jobs/101": _fixture("job_jsonld_full.html"),
                f"{ORIGIN}/jobs/stale": SourceFetchError("generic", "example", "HTTP 404: closed"),
            }
        )

        postings = await GenericAdapter().fetch(
            client,
            _company(),
            _company().sources[0],
        )

        assert [posting.source_job_id for posting in postings] == ["ENG-101"]

    @pytest.mark.asyncio
    async def test_company_request_ceiling_is_never_exceeded(self) -> None:
        urls = [f"{ORIGIN}/jobs/{index}" for index in range(150)]
        sitemap = "<urlset>" + "".join(f"<url><loc>{url}</loc></url>" for url in urls) + "</urlset>"
        responses: dict[str, str | Exception] = {
            f"{ORIGIN}/robots.txt": (f"User-agent: *\nAllow: /\nSitemap: {ORIGIN}/jobs.xml\n"),
            BASE: "<html></html>",
            f"{ORIGIN}/jobs.xml": sitemap,
        }
        for index, url in enumerate(urls):
            responses[url] = (
                '<script type="application/ld+json">'
                f'{{"@type":"JobPosting","title":"Intern {index}",'
                f'"identifier":"ID-{index}","url":"{url}"}}'
                "</script>"
            )
        client = URLMapClient(responses)

        postings = await GenericAdapter().fetch(
            client,
            _company(),
            _company().sources[0],
        )

        assert len(client.calls) == MAX_COMPANY_REQUESTS
        assert len(postings) == MAX_COMPANY_REQUESTS - 3


class TestGenericNormalizeAndRegistration:
    def test_normalize_preserves_rich_fields_and_method(self) -> None:
        adapter = GenericAdapter()
        raw = extract_json_ld(_fixture("job_jsonld_full.html"), "example", BASE)[0]

        posting = adapter.normalize(raw, _company(), NOW)

        assert posting.id == compute_posting_id("generic", "example", "ENG-101")
        assert posting.company == "Example Corp"
        assert posting.source == "generic"
        assert posting.ats == "generic"
        assert posting.locations == ["New York, NY, US", "Boston, MA, US", "Remote"]
        assert posting.compensation == "USD 30-42 per HOUR"
        assert posting.employment_type == "INTERN, FULL_TIME"
        assert posting.workplace_type == "Remote"
        assert posting.valid_through == "2026-10-01T23:59:59Z"
        assert posting.source_metadata is not None
        assert posting.source_metadata["extraction_method"] == "json_ld"
        assert posting.source_metadata["extraction_confidence"] == "high"
        assert posting.source_metadata["review_required"] is False
        assert posting.source_metadata["requisition_id"] == "ENG-101"
        assert posting.source_metadata["education_requirements"] == ("Enrolled in a degree program")
        assert posting.source_metadata["experience_requirements"] == (
            "No prior experience required"
        )
        assert posting.source_metadata["occupational_category"] == ("15-1252 Software Developers")

    def test_generic_is_registered_at_priority_five(self) -> None:
        assert "generic" in VALID_SOURCE_TYPES
        assert ADAPTERS["generic"] is GenericAdapter
        assert isinstance(get_adapter("generic"), GenericAdapter)
        assert SOURCE_PRIORITY["generic"] == 5

    @pytest.mark.parametrize(
        "token, expected",
        [
            ("careers.example.com/careers", BASE),
            (BASE, BASE),
            (f"{BASE}/", BASE),
        ],
    )
    def test_board_token_normalization(self, token: str, expected: str) -> None:
        assert GenericAdapter.normalize_board_url(token) == expected

    @pytest.mark.parametrize(
        "token",
        ["http://localhost/jobs", "http://127.0.0.1/jobs", "file:///tmp/jobs", "x@y.com"],
    )
    def test_unsafe_board_token_is_rejected(self, token: str) -> None:
        with pytest.raises(ValueError, match="public HTTP"):
            GenericAdapter.normalize_board_url(token)
