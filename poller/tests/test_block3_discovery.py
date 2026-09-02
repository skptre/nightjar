from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import yaml

from poller.discovery.catalog import (
    generate_registry_candidates,
    load_catalog,
    merge_catalog,
    save_catalog,
)
from poller.discovery.common_crawl import (
    POC_QUERY_PATTERNS,
    canonicalize_board_url,
    discover_common_crawl,
)
from poller.discovery.directories import (
    extract_directory_domains,
    normalize_public_domain,
)
from poller.discovery.identity import (
    CompanyIdentity,
    load_identity_file,
    resolve_identity,
    save_identity_file,
)
from poller.discovery.models import BoardCandidate
from poller.discovery.redirect_detect import discover_redirects
from poller.discovery.verify import verify_candidate
from poller.exceptions import SourceFetchError, SourceParseError
from poller.http import RateLimitedClient
from poller.tools.discover import run_discovery

NOW = datetime(2026, 9, 1, 18, 0, tzinfo=UTC)
NOW_TEXT = "2026-09-01T18:00:00Z"


def _candidate(
    ats_type: str = "greenhouse",
    token: str = "acme",
    **changes: Any,
) -> BoardCandidate:
    values: dict[str, Any] = {
        "ats_type": ats_type,
        "board_token": token,
        "board_url": f"https://boards.greenhouse.io/{token}",
        "discovery_source": "common_crawl",
        "first_seen": NOW_TEXT,
        "last_seen": NOW_TEXT,
        "source_urls": [f"https://boards.greenhouse.io/{token}/jobs/1"],
    }
    values.update(changes)
    return BoardCandidate(**values)


class FakeDiscoveryClient:
    def __init__(
        self,
        *,
        index_lines: dict[str, str] | None = None,
        json_responses: dict[str, Any] | None = None,
        redirect_urls: dict[str, str] | None = None,
        robots: dict[str, str] | None = None,
    ) -> None:
        self.index_lines = index_lines or {}
        self.json_responses = json_responses or {}
        self.redirect_urls = redirect_urls or {}
        self.robots = robots or {}
        self.text_calls: list[tuple[str, dict[str, str] | None]] = []
        self.json_calls: list[tuple[str, dict[str, str] | None]] = []
        self.redirect_calls: list[tuple[str, int]] = []

    async def get_json(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        **_: Any,
    ) -> Any:
        del source, company_slug
        self.json_calls.append((url, params))
        if url.endswith("collinfo.json"):
            return [
                {
                    "id": "CC-MAIN-2026-34",
                    "cdx-api": (
                        "https://index.commoncrawl.org/"
                        "CC-MAIN-2026-34-index"
                    ),
                },
                {
                    "id": "CC-MAIN-2026-30",
                    "cdx-api": "https://older.example/index",
                },
            ]
        if url not in self.json_responses:
            raise AssertionError(f"unexpected JSON URL: {url}")
        response = self.json_responses[url]
        if isinstance(response, Exception):
            raise response
        return response

    async def get_text(
        self,
        url: str,
        source: str = "",
        company_slug: str = "",
        params: dict[str, str] | None = None,
        **_: Any,
    ) -> str:
        del source, company_slug
        self.text_calls.append((url, params))
        if url.endswith("/robots.txt"):
            return self.robots.get(url, "User-agent: *\nAllow: /\n")
        assert params is not None
        pattern = params["url"]
        return self.index_lines.get(pattern, "")

    async def resolve_url(
        self,
        url: str,
        *,
        source: str = "",
        company_slug: str = "",
        max_redirects: int = 3,
    ) -> tuple[str, int]:
        del source, company_slug
        self.redirect_calls.append((url, max_redirects))
        return self.redirect_urls.get(url, url), 200

    async def post_json(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        source: str = "",
        company_slug: str = "",
    ) -> Any:
        del json_body, source, company_slug
        if url not in self.json_responses:
            raise AssertionError(f"unexpected POST URL: {url}")
        response = self.json_responses[url]
        if isinstance(response, Exception):
            raise response
        return response


class TestCandidateCanonicalization:
    @pytest.mark.parametrize(
        ("url", "ats_type", "token", "canonical"),
        [
            (
                "https://boards.greenhouse.io/Acme/jobs/123?gh_jid=123",
                "greenhouse",
                "Acme",
                "https://boards.greenhouse.io/Acme",
            ),
            (
                "https://job-boards.greenhouse.io/acme/jobs/123",
                "greenhouse",
                "acme",
                "https://boards.greenhouse.io/acme",
            ),
            (
                "https://jobs.lever.co/acme/123/apply",
                "lever",
                "acme",
                "https://jobs.lever.co/acme",
            ),
            (
                "https://jobs.eu.lever.co/acme/123",
                "lever",
                "acme",
                "https://jobs.eu.lever.co/acme",
            ),
            (
                "https://jobs.ashbyhq.com/acme/123",
                "ashby",
                "acme",
                "https://jobs.ashbyhq.com/acme",
            ),
            (
                "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/1",
                "workday",
                "acme.wd5.myworkdayjobs.com/Careers",
                "https://acme.wd5.myworkdayjobs.com/Careers",
            ),
            (
                "https://jobs.smartrecruiters.com/Acme/123-role",
                "smartrecruiters",
                "Acme",
                "https://jobs.smartrecruiters.com/Acme",
            ),
        ],
    )
    def test_extracts_stable_board_identity(
        self, url: str, ats_type: str, token: str, canonical: str,
    ) -> None:
        candidate = canonicalize_board_url(url, "common_crawl", NOW)

        assert candidate is not None
        assert candidate.ats_type == ats_type
        assert candidate.board_token == token
        assert candidate.board_url == canonical
        assert candidate.first_seen == NOW_TEXT

    @pytest.mark.parametrize(
        "url",
        [
            "https://example.com/jobs",
            "javascript:alert(1)",
            "https://user:pass@jobs.lever.co/acme/123",
            "https://jobs.lever.co/../admin",
            "https://jobs.ashbyhq.com/%2F",
        ],
    )
    def test_rejects_unknown_or_unsafe_urls(self, url: str) -> None:
        assert canonicalize_board_url(url, "common_crawl", NOW) is None

    def test_candidate_round_trip_is_stable(self) -> None:
        candidate = _candidate(
            company_name="Acme, Inc.",
            employer_domain="acme.com",
            verification_status="verified",
            job_count_at_verification=12,
            estimated_poll_cost=1,
        )

        restored = BoardCandidate.from_dict(candidate.to_dict())

        assert restored == candidate
        assert restored.key == ("greenhouse", "acme")


@pytest.mark.asyncio()
class TestCommonCrawlDiscovery:
    async def test_uses_latest_index_and_only_bounded_poc_patterns(self) -> None:
        client = FakeDiscoveryClient(
            index_lines={
                "boards.greenhouse.io/*": "\n".join(
                    [
                        json.dumps({"url": "https://boards.greenhouse.io/acme/jobs/1"}),
                        json.dumps({"url": "https://boards.greenhouse.io/acme/jobs/2"}),
                    ]
                ),
                "jobs.lever.co/*": json.dumps(
                    {"url": "https://jobs.lever.co/beta/one"}
                ),
                "jobs.ashbyhq.com/*": json.dumps(
                    {"url": "https://jobs.ashbyhq.com/gamma/one"}
                ),
            }
        )

        batch = await discover_common_crawl(client, now=NOW)

        assert POC_QUERY_PATTERNS == (
            "boards.greenhouse.io/*",
            "jobs.lever.co/*",
            "jobs.ashbyhq.com/*",
        )
        assert [candidate.board_token for candidate in batch.candidates] == [
            "acme", "beta", "gamma",
        ]
        assert batch.metrics.index_id == "CC-MAIN-2026-34"
        assert batch.metrics.raw_urls == 4
        assert batch.metrics.duplicates == 1
        assert all(
            call[0].endswith("CC-MAIN-2026-34-index")
            for call in client.text_calls
        )
        assert all(
            params is not None and params["limit"] == "500"
            for _, params in client.text_calls
        )

    async def test_dedupes_registry_sources_before_verification(self) -> None:
        client = FakeDiscoveryClient(
            index_lines={
                "boards.greenhouse.io/*": json.dumps(
                    {"url": "https://boards.greenhouse.io/acme/jobs/1"}
                ),
                "jobs.lever.co/*": json.dumps(
                    {"url": "https://jobs.lever.co/newco/1"}
                ),
            }
        )

        batch = await discover_common_crawl(
            client,
            known_source_keys={("greenhouse", "acme")},
            now=NOW,
        )

        assert [candidate.board_token for candidate in batch.candidates] == ["newco"]
        assert batch.metrics.existing_registry == 1

    async def test_enforces_global_candidate_budget(self) -> None:
        lines = "\n".join(
            json.dumps({"url": f"https://boards.greenhouse.io/company-{i}/jobs/1"})
            for i in range(520)
        )
        client = FakeDiscoveryClient(
            index_lines={"boards.greenhouse.io/*": lines}
        )

        batch = await discover_common_crawl(client, max_candidates=500, now=NOW)

        assert len(batch.candidates) == 500
        assert batch.metrics.budget_exhausted is True
        assert len(client.text_calls) == 3

    async def test_candidate_budget_is_fair_across_poc_ats_families(self) -> None:
        greenhouse = "\n".join(
            json.dumps({"url": f"https://boards.greenhouse.io/gh-{i}/jobs/1"})
            for i in range(500)
        )
        client = FakeDiscoveryClient(
            index_lines={
                "boards.greenhouse.io/*": greenhouse,
                "jobs.lever.co/*": json.dumps(
                    {"url": "https://jobs.lever.co/lever-only/1"}
                ),
                "jobs.ashbyhq.com/*": json.dumps(
                    {"url": "https://jobs.ashbyhq.com/ashby-only/1"}
                ),
            }
        )

        batch = await discover_common_crawl(client, max_candidates=500, now=NOW)
        tokens = {candidate.board_token for candidate in batch.candidates}

        assert len(batch.candidates) == 500
        assert "lever-only" in tokens
        assert "ashby-only" in tokens
        assert len(client.text_calls) == 3

    async def test_skips_malformed_ndjson_rows(self) -> None:
        client = FakeDiscoveryClient(
            index_lines={
                "boards.greenhouse.io/*": (
                    "not-json\n"
                    '{"url": 42}\n'
                    '{"url": "https://example.com/nope"}\n'
                    '{"url": "https://boards.greenhouse.io/acme/jobs/1"}'
                )
            }
        )

        batch = await discover_common_crawl(client, now=NOW)

        assert [candidate.board_token for candidate in batch.candidates] == ["acme"]
        assert batch.metrics.malformed_rows == 2
        assert batch.metrics.unrecognized_urls == 1

    async def test_html_error_page_is_failure_not_empty_discovery(self) -> None:
        client = FakeDiscoveryClient(
            index_lines={
                "boards.greenhouse.io/*": "<html><title>upstream error</title></html>"
            }
        )

        with pytest.raises(SourceParseError, match="no valid CDX rows"):
            await discover_common_crawl(client, now=NOW)


class TestCatalog:
    def test_merge_preserves_first_seen_and_combines_provenance(self) -> None:
        existing = _candidate(
            first_seen="2026-08-01T00:00:00Z",
            last_seen="2026-08-01T00:00:00Z",
            source_urls=["https://boards.greenhouse.io/acme/jobs/old"],
            verification_status="verified",
            last_verified="2026-08-02T00:00:00Z",
            job_count_at_verification=7,
        )
        incoming = _candidate(
            discovery_source="redirect",
            source_urls=["https://acme.com/careers"],
        )

        merged = merge_catalog([existing], [incoming], now=NOW)

        assert len(merged) == 1
        candidate = merged[0]
        assert candidate.first_seen == "2026-08-01T00:00:00Z"
        assert candidate.last_seen == NOW_TEXT
        assert candidate.verification_status == "verified"
        assert candidate.discovery_sources == ["common_crawl", "redirect"]
        assert candidate.source_urls == [
            "https://acme.com/careers",
            "https://boards.greenhouse.io/acme/jobs/old",
        ]

    def test_catalog_file_has_versioned_deterministic_schema(self, tmp_path: Path) -> None:
        path = tmp_path / "discovered_boards.json"
        candidates = [_candidate(token="zeta"), _candidate(token="alpha")]

        save_catalog(
            path,
            candidates,
            generated_at=NOW_TEXT,
            metrics={"candidate_count": 2},
        )

        raw = json.loads(path.read_text(encoding="utf-8"))
        assert raw["schema_version"] == 1
        assert raw["generated_at"] == NOW_TEXT
        assert [item["board_token"] for item in raw["candidates"]] == [
            "alpha", "zeta",
        ]
        assert load_catalog(path) == sorted(candidates, key=lambda item: item.key)

    def test_only_verified_supported_boards_become_registry_candidates(self) -> None:
        verified = _candidate(
            company_name="Acme Corporation",
            verification_status="verified",
            job_count_at_verification=10,
        )
        pending = _candidate(token="pending")
        review = _candidate(
            ats_type="workday",
            token="acme.wd5.myworkdayjobs.com/Careers",
            board_url="https://acme.wd5.myworkdayjobs.com/Careers",
            verification_status="review_required",
            review_required=True,
        )

        generated = generate_registry_candidates(
            [verified, pending, review],
            existing=[{"slug": "other", "name": "Other"}],
        )

        assert [item["slug"] for item in generated] == ["other", "acme-corporation"]
        assert generated[1]["inferred_ats"] == "greenhouse"
        assert generated[1]["inferred_board_token"] == "acme"
        assert generated[1]["discovery_source"] == "common_crawl"


@pytest.mark.asyncio()
class TestVerification:
    async def test_verifies_greenhouse_and_records_cost(self) -> None:
        url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs"
        client = FakeDiscoveryClient(
            json_responses={url: {"jobs": [{"id": 1}, {"id": 2}]}}
        )

        verified = await verify_candidate(client, _candidate(), now=NOW)

        assert verified.verification_status == "verified"
        assert verified.job_count_at_verification == 2
        assert verified.estimated_poll_cost == 1
        assert verified.last_verified == NOW_TEXT
        assert verified.response_status == 200

    @pytest.mark.parametrize(
        ("candidate", "url", "response", "count"),
        [
            (
                _candidate(
                    ats_type="lever",
                    token="acme",
                    board_url="https://jobs.lever.co/acme",
                ),
                "https://api.lever.co/v0/postings/acme?mode=json",
                [{"id": "1"}, {"id": "2"}],
                2,
            ),
            (
                _candidate(
                    ats_type="ashby",
                    token="acme",
                    board_url="https://jobs.ashbyhq.com/acme",
                ),
                "https://api.ashbyhq.com/posting-api/job-board/acme",
                {"jobs": [{"id": "1"}]},
                1,
            ),
            (
                _candidate(
                    ats_type="smartrecruiters",
                    token="Acme",
                    board_url="https://jobs.smartrecruiters.com/Acme",
                ),
                "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=1",
                {"totalFound": 201, "content": []},
                201,
            ),
        ],
    )
    async def test_verifies_supported_json_boards(
        self,
        candidate: BoardCandidate,
        url: str,
        response: Any,
        count: int,
    ) -> None:
        client = FakeDiscoveryClient(json_responses={url: response})

        verified = await verify_candidate(client, candidate, now=NOW)

        assert verified.verification_status == "verified"
        assert verified.job_count_at_verification == count

    async def test_workday_is_never_auto_promoted(self) -> None:
        token = "acme.wd5.myworkdayjobs.com/Careers"
        url = "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs"
        candidate = _candidate(
            ats_type="workday",
            token=token,
            board_url="https://acme.wd5.myworkdayjobs.com/Careers",
        )
        client = FakeDiscoveryClient(json_responses={url: {"total": 41}})

        verified = await verify_candidate(client, candidate, now=NOW)

        assert verified.verification_status == "review_required"
        assert verified.review_required is True
        assert verified.job_count_at_verification == 41
        assert verified.estimated_poll_cost == 3

    async def test_404_is_dead_but_transient_failure_remains_pending(self) -> None:
        url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs"
        dead_client = FakeDiscoveryClient(
            json_responses={
                url: SourceFetchError("greenhouse", "acme", "HTTP 404: missing")
            }
        )
        transient_client = FakeDiscoveryClient(
            json_responses={
                url: SourceFetchError("greenhouse", "acme", "HTTP 503 after retries")
            }
        )

        dead = await verify_candidate(dead_client, _candidate(), now=NOW)
        transient = await verify_candidate(transient_client, _candidate(), now=NOW)

        assert dead.verification_status == "dead"
        assert dead.response_status == 404
        assert transient.verification_status == "pending"
        assert transient.response_status == 503

    async def test_schema_drift_is_not_mistaken_for_empty_board(self) -> None:
        url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs"
        client = FakeDiscoveryClient(json_responses={url: {"unexpected": []}})

        candidate = await verify_candidate(client, _candidate(), now=NOW)

        assert candidate.verification_status == "pending"
        assert candidate.job_count_at_verification is None


class TestRedirectAndDirectories:
    @pytest.mark.asyncio()
    async def test_redirect_detection_respects_robots_and_three_hop_limit(self) -> None:
        client = FakeDiscoveryClient(
            robots={
                "https://allowed.com/robots.txt": "User-agent: *\nAllow: /careers\n",
                "https://blocked.com/robots.txt": (
                    "User-agent: *\nDisallow: /careers\nDisallow: /jobs\n"
                ),
            },
            redirect_urls={
                "https://allowed.com/careers": "https://jobs.lever.co/allowed/jobs/1",
            },
        )

        candidates = await discover_redirects(
            ["allowed.com", "blocked.com"], client, now=NOW,
        )

        assert [candidate.board_token for candidate in candidates] == ["allowed"]
        assert client.redirect_calls == [("https://allowed.com/careers", 3)]
        assert candidates[0].discovery_source == "redirect"

    def test_directory_records_use_only_explicit_public_websites(self) -> None:
        records = [
            {"name": "Acme", "website": "https://www.acme.com/about"},
            {"name": "Beta", "website_url": "beta.org"},
            {"name": "Missing"},
            {"name": "ATS", "website": "https://boards.greenhouse.io/acme"},
            {"name": "Unsafe", "website": "file:///etc/passwd"},
        ]

        domains = extract_directory_domains(records, source="sec_edgar")

        assert domains == ["acme.com", "beta.org"]

    @pytest.mark.parametrize(
        "value",
        [
            "localhost",
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "[::1]",
            "internal",
        ],
    )
    def test_directory_domains_reject_private_or_non_dns_targets(self, value: str) -> None:
        assert normalize_public_domain(value) is None


class TestIdentityResolution:
    def test_identity_file_round_trips_relationships_and_review_queue(
        self, tmp_path: Path,
    ) -> None:
        path = tmp_path / "company_identities.json"
        identity = CompanyIdentity(
            slug="instagram",
            canonical_name="Instagram LLC",
            aliases=["Instagram"],
            domains=["instagram.com"],
            ats_instances=[{"ats_type": "greenhouse", "board_token": "instagram"}],
            parent_company="meta",
            subsidiaries=["threads"],
        )
        review = [{"ats_type": "lever", "board_token": "unknown"}]

        save_identity_file(path, [identity], review)
        identities, pending = load_identity_file(path)

        assert identities == [identity]
        assert pending == review

    def test_missing_identity_file_is_an_empty_safe_baseline(self, tmp_path: Path) -> None:
        assert load_identity_file(tmp_path / "missing.json") == ([], [])

    def test_exact_ats_instance_auto_matches(self) -> None:
        identities = [
            CompanyIdentity(
                slug="acme",
                canonical_name="Acme",
                ats_instances=[{"ats_type": "greenhouse", "board_token": "acme"}],
            )
        ]

        result = resolve_identity(_candidate(), identities)

        assert result.status == "matched"
        assert result.identity_slug == "acme"
        assert result.reason == "exact_ats_instance"

    def test_employer_domain_links_multiple_ats_but_ats_host_never_does(self) -> None:
        identities = [
            CompanyIdentity(
                slug="acme",
                canonical_name="Acme",
                domains=["acme.com"],
            )
        ]
        same_company = _candidate(
            ats_type="workday",
            token="acme.wd5.myworkdayjobs.com/Careers",
            board_url="https://acme.wd5.myworkdayjobs.com/Careers",
            employer_domain="jobs.acme.com",
        )
        hosted_only = _candidate(employer_domain="boards.greenhouse.io")

        matched = resolve_identity(same_company, identities)
        unmatched = resolve_identity(hosted_only, identities)

        assert matched.status == "matched"
        assert matched.identity_slug == "acme"
        assert matched.reason == "employer_domain"
        assert unmatched.status == "new_review_required"

    def test_fuzzy_name_only_proposes_review_never_auto_merge(self) -> None:
        identities = [
            CompanyIdentity(
                slug="jpmorgan-chase",
                canonical_name="JPMorgan Chase & Co.",
                aliases=["JPMorgan Chase", "JPMC"],
            )
        ]
        candidate = _candidate(company_name="JP Morgan Chase")

        result = resolve_identity(candidate, identities)

        assert result.status == "review_required"
        assert result.identity_slug == "jpmorgan-chase"
        assert result.score is not None
        assert result.score >= 90

    def test_parent_and_subsidiary_are_not_merged_by_relationship(self) -> None:
        identities = [
            CompanyIdentity(
                slug="meta",
                canonical_name="Meta",
                subsidiaries=["instagram"],
            ),
            CompanyIdentity(
                slug="instagram",
                canonical_name="Instagram",
                parent_company="meta",
            ),
        ]
        candidate = _candidate(company_name="Instagram")

        result = resolve_identity(candidate, identities)

        assert result.status == "review_required"
        assert result.identity_slug == "instagram"
        assert result.identity_slug != "meta"


class TestDiscoveryIntegration:
    @pytest.mark.asyncio()
    async def test_full_poc_loop_writes_catalog_and_review_queue(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        registry_path.write_text(
            yaml.safe_dump(
                [
                    {
                        "slug": "known",
                        "name": "Known",
                        "tags": ["tech"],
                        "sources": [
                            {"type": "greenhouse", "board_token": "known"}
                        ],
                    }
                ],
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        index_lines = {
            "boards.greenhouse.io/*": "\n".join(
                [
                    json.dumps({"url": "https://boards.greenhouse.io/known/jobs/1"}),
                    json.dumps({"url": "https://boards.greenhouse.io/acme/jobs/1"}),
                ]
            )
        }
        verify_url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs"
        client = FakeDiscoveryClient(
            index_lines=index_lines,
            json_responses={verify_url: {"jobs": [{"id": 1}]}},
        )

        summary = await run_discovery(
            data_dir=data_dir,
            registry_path=registry_path,
            client=client,
            now=NOW,
        )

        catalog = json.loads(
            (data_dir / "discovered_boards.json").read_text(encoding="utf-8")
        )
        registry_candidates = json.loads(
            (data_dir / "registry_candidates.json").read_text(encoding="utf-8")
        )
        identities = json.loads(
            (data_dir / "company_identities.json").read_text(encoding="utf-8")
        )
        assert summary.discovered == 1
        assert summary.verified == 1
        assert catalog["metrics"]["existing_registry"] == 1
        assert catalog["candidates"][0]["verification_status"] == "verified"
        assert registry_candidates[0]["inferred_board_token"] == "acme"
        assert identities["pending_review"][0]["board_token"] == "acme"

    @pytest.mark.asyncio()
    async def test_structured_directory_redirects_join_catalog_without_verification(
        self, tmp_path: Path,
    ) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        registry_path = tmp_path / "companies.yaml"
        registry_path.write_text(
            yaml.safe_dump(
                [
                    {
                        "slug": "known",
                        "name": "Known",
                        "tags": ["tech"],
                        "sources": [
                            {"type": "greenhouse", "board_token": "known"}
                        ],
                    }
                ],
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        directory_path = tmp_path / "directory.json"
        directory_path.write_text(
            json.dumps([{"name": "Beta", "website": "https://beta.example"}]),
            encoding="utf-8",
        )
        client = FakeDiscoveryClient(
            redirect_urls={
                "https://beta.example/careers": "https://jobs.lever.co/beta/1"
            }
        )

        summary = await run_discovery(
            data_dir=data_dir,
            registry_path=registry_path,
            directory_records_path=directory_path,
            client=client,
            verify=False,
            now=NOW,
        )

        catalog = load_catalog(data_dir / "discovered_boards.json")
        assert summary.discovered == 1
        assert summary.verified == 0
        assert catalog[0].board_token == "beta"
        assert catalog[0].employer_domain == "beta.example"
        assert catalog[0].discovery_sources == ["directory", "redirect"]
        assert catalog[0].verification_status == "pending"

    def test_discovery_workflow_is_monthly_manual_bounded_and_serialized(self) -> None:
        workflow = Path(".github/workflows/discover.yml").read_text(encoding="utf-8")

        assert 'cron: "17 6 1 * *"' in workflow
        assert "workflow_dispatch:" in workflow
        assert "timeout-minutes: 90" in workflow
        assert "cancel-in-progress: false" in workflow
        assert "python -m poller.tools.discover" in workflow
        assert "--max-candidates 500" in workflow
        assert "actions/upload-artifact@v4" in workflow
        assert "path: data/registry_candidates.json" in workflow
        git_add_line = next(
            line.strip() for line in workflow.splitlines() if line.strip().startswith("git add")
        )
        assert "data/registry_candidates.json" not in git_add_line


@pytest.mark.asyncio()
class TestDiscoveryHttpPrimitives:
    async def test_get_text_uses_honest_client_and_returns_ndjson(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["user-agent"].startswith("nightjar/")
            return httpx.Response(
                200,
                text='{"url":"https://jobs.lever.co/acme/1"}\n',
                headers={"content-type": "application/x-ndjson"},
            )

        client = RateLimitedClient()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("poller.http.MIN_HOST_DELAY", 0), patch("poller.http.MAX_JITTER", 0):
            text = await client.get_text("https://index.commoncrawl.org/test")
        await client.close()

        assert text.endswith("\n")

    async def test_resolve_url_stops_after_three_redirects(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            hop = int(request.url.path.removeprefix("/hop/"))
            return httpx.Response(302, headers={"location": f"/hop/{hop + 1}"})

        client = RateLimitedClient()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with (
            patch("poller.http.MIN_HOST_DELAY", 0),
            patch("poller.http.MAX_JITTER", 0),
            pytest.raises(SourceFetchError, match="redirect limit"),
        ):
            await client.resolve_url("https://example.test/hop/0", max_redirects=3)
        await client.close()

    async def test_resolve_url_rejects_redirects_to_private_networks(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "public.example":
                return httpx.Response(
                    302, headers={"location": "http://169.254.169.254/latest/meta-data"}
                )
            return httpx.Response(200)

        client = RateLimitedClient()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with (
            patch("poller.http.MIN_HOST_DELAY", 0),
            patch("poller.http.MAX_JITTER", 0),
            pytest.raises(SourceFetchError, match="unsafe redirect URL"),
        ):
            await client.resolve_url("https://public.example/careers")
        await client.close()
