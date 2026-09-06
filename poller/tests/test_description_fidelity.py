"""Synthetic API fixtures: section and ending fidelity, not live provider certification."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from poller.description_enrich import enrich_posting_descriptions, fetch_description
from poller.models import Company, Posting, SourceConfig
from poller.normalize import html_to_plaintext
from poller.sources.lever import LeverAdapter
from poller.store import load_feed, save_feed
from poller.tests.test_description_enrich import TS, FakeClient, make_posting

FIXTURE = Path(__file__).parent / "fixtures" / "lever" / "sectioned_job.json"


def test_html_preserves_sections_and_excludes_non_content() -> None:
    raw = (
        '<h2>Required qualifications</h2><ul><li>U.S. <b>citizens only</b>.</li>'
        '<li>Degree completed in 2028.</li></ul><h2>Preferred</h2><p>Python.</p>'
        '<script>Visa sponsorship is available.</script><style>body { color:red }</style>'
    )
    assert html_to_plaintext(raw) == (
        'Required qualifications\n\n- U.S. citizens only.\n- Degree completed in 2028.'
        '\n\nPreferred\n\nPython.'
    )


def test_plaintext_preserves_paragraphs_and_literal_comparisons() -> None:
    text = 'Responsibilities\n\nBuild systems with latency < 5 ms.\n\nRequired\nGraduating 2028.'
    assert html_to_plaintext(text) == text


@pytest.mark.asyncio
async def test_lever_board_and_detail_keep_same_complete_source_sections(tmp_path: Path) -> None:
    job = json.loads(FIXTURE.read_text(encoding='utf-8'))
    # The decisive clause occurs beyond the former 5,000-character cutoff.
    job['description'] += '<p>' + 'Build reliable flight controls. ' * 220 + '</p>'
    company = Company(slug='example', name='Example', tags=[],
                      sources=[SourceConfig(type='lever', board_token='example')])
    adapter = LeverAdapter()
    raw = adapter._parse_job(job, company)
    board_posting = adapter.normalize(raw, company, TS)
    detail_posting = make_posting('detail', ats='lever', url=job['hostedUrl'])
    api = 'https://api.lever.co/v0/postings/example/sectioned-intern'
    enriched, count = await enrich_posting_descriptions(
        [detail_posting], {}, FakeClient({api: job}), run_number=0,
    )
    assert count == 1
    description = enriched[0].description_text
    assert description == board_posting.description_text
    assert len(description) > 5000
    assert description.count('Build flight software.') == 1
    assert 'Required qualifications\n\n- Graduating between' in description
    assert 'Preferred qualifications\n\n- Experience with embedded Linux.' in description
    assert 'This position is open only to U.S. citizens.' in description[5000:]
    assert description.endswith('Housing stipend is separate.')
    # Exercise real public serialization and disk round-trip, not just the parser.
    path = tmp_path / 'feed.json'
    save_feed(path, {enriched[0].id: enriched[0]}, TS)
    restored = load_feed(path)
    assert restored[enriched[0].id].description_text == description
    assert Posting.from_dict(board_posting.to_dict()).description_text == description


@pytest.mark.asyncio
async def test_smartrecruiters_preserves_heading_and_exception_scope() -> None:
    api = 'https://api.smartrecruiters.com/v1/companies/Acme/postings/abc'
    client = FakeClient({api: {'jobAd': {'sections': {
        'qualifications': {
            'title': 'Required qualifications',
            'text': '<p>Must be a U.S. citizen unless an exception is approved.</p>',
        },
        'additionalInformation': {'title': 'Additional information',
                                  'text': '<p>Pay: $30/hour.</p>'},
    }}}})
    posting = make_posting('sr', ats='smartrecruiters',
                           url='https://jobs.smartrecruiters.com/Acme/abc')
    assert await fetch_description(client, posting, {}, asyncio.Lock()) == (
        'Required qualifications\n\nMust be a U.S. citizen unless an exception is approved.'
        '\n\nAdditional information\n\nPay: $30/hour.'
    )


@pytest.mark.asyncio
async def test_workday_accepts_nested_detail_without_dropping_ending() -> None:
    api = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Intern_R123'
    text = 'A' * 6000 + '\n\nApplicants must graduate in 2028.'
    client = FakeClient({api: {'jobPostingInfo': {'jobDescription': text}}})
    posting = make_posting('wd', ats='workday',
                           url='https://acme.wd5.myworkdayjobs.com/External/job/Intern_R123')
    assert await fetch_description(client, posting, {}, asyncio.Lock()) == text


@pytest.mark.asyncio
async def test_ashby_html_only_description_is_not_discarded() -> None:
    api = 'https://api.ashbyhq.com/posting-api/job-board/acme'
    client = FakeClient({api: {'jobs': [{'id': '1',
        'descriptionHtml': '<h2>Required</h2><p>Graduating in 2028.</p>'}]}})
    posting = make_posting('ash', ats='ashby', url='https://jobs.ashbyhq.com/acme/1')
    assert await fetch_description(client, posting, {}, asyncio.Lock()) == (
        'Required\n\nGraduating in 2028.'
    )
