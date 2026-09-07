# Description engine recovery audit — September 7, 2026

The committed extractor (`be45984`) survived the restart. Four uncommitted files
contained additional ATS work. That work is now integrated with regression coverage;
production validation and the final UI remain outstanding.

## Recovered evidence

The isolated `.tmp/description-backfill` run was made on September 6 at
20:03:43 UTC. Its feed SHA-256 is
`68a3594e195386e2a2eaa2334258fba69004ad0c7ca9f2b4bc784cda57ecc190`.
It contains 4,305 active postings, with 12 descriptions from 20 attempted jobs.
These are recovered results, not new requests made during this session.

| Provider label in saved feed | Attempts | Descriptions returned |
|---|---:|---:|
| Workday | 5 | 5 |
| Greenhouse | 2 | 2 |
| Ashby | 3 | 3 |
| SmartRecruiters | 1 | 1 |
| Lever | 2 | 1 |
| Other / first-party | 7 | 0 |

Five failures recorded only `ValueError`; three recorded `SourceFetchError`.
Those old records cannot distinguish robots denial from a mismatched structured job.
New collection records retain those specific validation reasons.

The batch follows posting-ID order and is small. Its 12/20 result is not an estimate
of production coverage. It contains no successful first-party fallback or new-provider
detail acquisition, and does not cover quant, finance, or the full occupation taxonomy.

## Corrections supported by inspection

- The J&J Design and Development description's employer recruiting sentence was
  incorrectly used as recruiting-job evidence. Description classification now requires
  the candidate or an imperative action as subject. Generic product-design/laboratory
  activities alone no longer assert design/research occupations. This posting remains
  unresolved instead of acquiring unsupported professions.
- Hermeus's Software Engineer Intern — Hardware in the Loop is SWE, with Aerospace
  field evidence from the duties. The test environment no longer adds a Hardware role.
- Bosch's Technical Functions/Maintenance intern has explicit inventory/procurement
  duties and resolves from Other to Supply chain. True Anomaly's GSE role gains
  aerospace/mechanical/electrical duties without an Operations role from the phrase
  describing where its mechanical designs will be used.
- J&J's repeated-unit hourly ranges now remain a single $23.50–$52.50/hour range.
  Booz Allen's explicitly annualized range keeps the advertised annual period.
  Different currencies, periods and pay components remain separate.
- Employer heading variants, including emoji-prefixed headings, preserve section scope.
  Paragraph-wrapped list bullets stay attached during normalization. Legacy detached
  bullets are grouped into original passages without changing source offsets.

The offline audit reports zero invalid offsets across the extracted passages in these
12 documents. Among these same 12 records, unclassified roles change from three without
descriptions to two with descriptions; two role-tag sets change. This is neither an
accuracy score nor a section precision/recall measurement. Narrow regression examples
were selected after inspection and are not an independent holdout.

## Collection changes and limits

- Acquisition version 3 validates provider hosts/paths and shares detection with Simplify.
  Workable detail assembly requires the description, requirements and benefits fields;
  listing teasers are not certified. This public endpoint still needs a live check.
- iCIMS, JazzHR and Rippling use the conservative matching JobPosting JSON-LD path,
  including robots checks and no redirects. Whole-page HTML and login/application shells
  cannot become complete descriptions. Recognizing a URL does not guarantee JSON-LD exists.
- Custom Greenhouse URLs require source identity or an unambiguous curated board.
  Company slugs are never guessed as board names. Registry corrections invalidate
  retry state. Descriptions waiting beyond their refresh window are marked stale.
- The original 4,305-posting input now has 3,009 resolvable ATS targets versus 2,653
  before these changes. This includes conditional structured-page candidates, not
  3,009 verified descriptions.
- Backfill uses the same registry mapping as the poller and reports attempts, provider
  states, failure reasons and payload sizes. It resumes without modifying its input.

The recovered source shards total about 4.00 MB uncompressed (largest: Simplify,
2,802,968 bytes), with only 12 descriptions present. This is not a full-backfill size
projection. An offline 12-document extraction/classification pass took roughly
0.33 seconds on this machine; this excludes module loading and is not app cache latency.

## Reproduction and remaining gate

```sh
python -m poller.tools.enrich_descriptions
# Only in an environment that can reach the public sources:
python -m poller.tools.enrich_descriptions --live --limit 200 --output .tmp/description-backfill
cd app
npm run audit:details -- ../.tmp/description-backfill/feed.json
```

`audit:details` reports feed hash, engine versions, exact-offset checks, pay labels,
sections, authorization/graduation evidence, and before/after role evidence. It uses
no private profile and makes no network requests. Current versions: details 2,
classification 4, public acquisition 3.

Validation: 1,120 offline Python tests and 1,073 frontend tests pass. Ruff, strict mypy,
TypeScript and the production build pass. This Windows sandbox required a workspace
pytest temporary directory and a temporary programmatic Vite runner loading the same
configuration; ordinary CLI config loading hit a parent-directory permission error.

A public Greenhouse request failed here with `All connection attempts failed`.
No further live backfill, public feed publication, workflow restart or UI rollout
occurred. Continue with a source-stratified live run, separately reviewed occupation
and section labels, pay/exclusion/graduation evaluation, full-backfill shard sizes and
real app cache latency. Keep the UI-last release gate in `expansion.md`.





