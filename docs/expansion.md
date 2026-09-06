# Nightjar expansion: job descriptions, requirements, and coverage

Approved direction: September 6, 2026. This is the active implementation plan.
`spec.md` remains the product specification. This document records the complete
agreed behavior and the order of work, including work that is not implemented yet.

## Priority and scope

Build description collection first, then the posting expansion and local extraction
as one feature. Complete descriptions supply the evidence for better classification,
compensation, qualifications, and authorization handling. Do not spend another cycle
adding title keywords while leaving available description evidence unused.

After this feature is measured, expand discovery and acquisition across disciplines
and smaller employers. Richer descriptions improve existing coverage; they do not
discover missing employers by themselves. Resume-based fit is a separate later feature.

## Agreed posting experience

- Keep the large, browsable list. Clicking a posting expands its details without
  losing the user's place. Handle variable heights/accessibility deliberately with
  the existing virtualized list. The agreed interaction is expansion from the list;
  a separate standalone job page is not required.
- Show selected passages from the actual employer description, preserving wording,
  conditions, negations, exceptions, and bullets. Separate responsibilities, required
  qualifications, and preferred qualifications. Do not fabricate missing sections.
- Include a `Show full description` control inside the expansion. Default snippets
  are concise; retained source content is complete. When section detection is uncertain,
  show more original context rather than a confidently mislabeled short passage.
- The primary button is `Apply`, opening the original employer/ATS job URL. Preserve
  direct links supplied by Simplify; where an aggregator URL occurs, resolve a verified
  original URL without guessing. Other expansion buttons can be designed later.
- Do not display source/vendor labels, retrieval timestamps, provenance, extraction
  confidence, or a source section. Retain those facts internally for debugging and
  evidence. Apply provides access to the original posting.
- Omit a routine timing section. Surface dates/duration only when useful to the decision:
  unusual availability, fall/spring or co-op scheduling, an explicit start date, or a
  deadline. Retain underlying timing information. Graduation is handled separately below.
- Remove authorization-derived Match/Review/Unsure/Details-needed/eligibility badges.
  Do not replace them with a general eligibility verdict. Future fit indicators belong
  to the later resume-matching feature.

## Authorization: display evidence; exclude only explicit conflicts

- For F-1 CPT/OPT and other users with relevant authorization concerns, show the actual
  authorization passage when one exists. No generated yes/no answer, uncertainty text,
  colored status, or claim of immigration eligibility.
- If no relevant passage exists, omit the section and keep the posting. The user's
  phrase "assume yes" meant retaining the opportunity, not inferring employer acceptance.
- A retrieval failure and a successfully read document with no authorization language
  are different internal states. Neither is evidence for excluding an opportunity.
  Do not expose that distinction as authorization badges or explanatory verdicts.
- Hide from default results ONLY when explicit mandatory employer wording clearly
  conflicts with the local user's situation: e.g. citizens-only for a noncitizen, or
  explicit rejection of that user's authorization category. Preserve the supporting
  passage and evaluate exceptions/alternatives before excluding.
- `No sponsorship` alone is insufficient to reject every F-1 applicant. Neither a
  generic work-authorization requirement, a question on an application, company identity,
  nor an isolated clearance/ITAR keyword proves a conflict. No broad keyword vetoes.
- Separate CPT, OPT, STEM OPT, and future-sponsorship needs when the profile and employer
  evidence require that distinction. Incomplete profile information cannot prove a
  conflict. Keep all personal decisions and profile data local.
- Ordinary sponsorship sections are unnecessary for citizens/permanent residents.
  Relevant explicit restrictions remain in required qualifications; citizenship-only
  requirements can still matter to a permanent resident.
- Excluded jobs remain stored and inspectable, with their original restriction passage.
  Provide a quiet `Show excluded` control and preserve access through saved jobs. Do not
  turn exclusions into prominent ineligible counts or delete/hide saved applications.
- Do not silently penalize other jobs for missing or ambiguous authorization information.

## Graduation: demote clear mismatches, do not hide by default

- Keep the employer's graduation requirement in required qualifications.
- An explicit mandatory graduation window that clearly excludes the user's date moves
  the posting after ordinary results within the same role/field filters. Use a small
  neutral `Outside grad window` tag. Preserve the selected sort within both groups.
- Matching windows require no extra badge. Preferred graduation years, ambiguous dates,
  missing requirements, and insufficient profile precision do not trigger demotion.
- Do not manufacture month precision from a year-only user answer. Current enrollment,
  returning to school after the internship, degree level, and graduation windows are
  separate requirements; do not infer one solely from another.
- No general `ineligible` label or hard exclusion for graduation. A future user-controlled
  hide-mismatches option is optional later work, not part of the default behavior.

## Compensation: consistent placement and meaning

- Every list row has the same compensation area and deterministic formatting rules.
- Display supported amounts in their advertised currency and period (`$30–$40/hr`,
  `$6,000/month`). No silent annualization, estimated pay, or assumption that absent pay
  means unpaid.
- Use `Pay not listed` only when acquired content supports that absence; use
  `Pay unavailable` when necessary details could not be acquired. Never convert a fetch
  failure into an employer claim. Structured advertised pay can be shown independently
  of whether the description fetch succeeded.
- In the expansion, preserve location/education tiers and pay conditions. Separate base
  pay, bonus, equity, and housing/other stipends. Do not collapse incompatible ranges
  into a misleading min/max. Keep the source clause or structured field as evidence.

## Collection and extraction architecture

- Poller: collect complete public descriptions and structured source facts only.
  App: section selection, role classification, compensation interpretation, and private
  profile comparison. No personal data or eligibility judgments in public output.
- Preserve headings, paragraphs, lists, and the complete ending of descriptions.
  Remove the silent 5,000-character truncation in collection, serialization, and client
  fallback. Any future safety limit must explicitly track partial content.
- Assemble all relevant ATS fields, especially Lever lists/additional/salary text,
  Greenhouse content/pay transparency, Ashby description/compensation, and named
  SmartRecruiters sections. Validate Workday response variants with fixtures.
- Preserve ATS board/job identity independently of display URLs through ingestion and
  dedupe. Prefer supported public APIs, then first-party structured JobPosting data.
- Share collection across users. Keep the feed lightweight through versioned public
  detail chunks/cache as measured payload growth warrants. Cache downloaded details
  locally for offline reading. Do not fetch the same employer once per user by default.
- Track pending/success/partial/failed/unsupported retrieval states, last success,
  source/content version, retry/backoff, and staleness internally. A successful HTTP
  response is not necessarily a complete job description. Refresh existing content;
  retry fairly; keep the previous successful copy on failures.
- Stable inputs produce stable public output. Avoid unnecessary diffs from timestamps.
- Keep every extracted value linked to an original passage or structured source field.
  Negation, alternatives, conditions, and required/preferred scope are essential.
- Use structured fields and deterministic section extraction first. No model on every
  posting. Evaluate any later model assistance on held-out reviewed descriptions, with
  evidence requirements and the existing local/privacy boundary intact.
- Keep role and field axes: OR within roles, OR within fields, AND between axes. Richer
  descriptions provide duties evidence, not permission to classify from boilerplate or
  preferred skills. Fix top-level department wiring and version cached classifications.

## Delivery sequence and acceptance

1. **Collection fidelity (first implementation milestone).** Preserve complete structured
   description text, assemble missing ATS sections, and prove source-to-serialized-feed
   behavior with offline fixtures. Fix department wiring. No UI completion claim yet.
2. **Reliable public delivery.** Diagnose the empty-description snapshot with a controlled
   run; add explicit acquisition state, identity resolution, refresh/backoff, and measured
   public detail delivery. Verify fetch failures never erase successful content.
3. **Local evidence and ordering.** Replace broad eligibility rules with the agreed
   narrow authorization exclusions and graduation demotion. Recompute cached results on
   document/profile/extractor changes. Use the same document for role classification.
4. **Engine evaluation.** Review examples across ATSs and SWE, aerospace, hardware,
   quant, finance, and less common roles. Measure completeness, section fidelity, pay
   precision, erroneous exclusions, graduation ordering, and classifier correctness.
   Unknown-to-known counts alone are not accuracy. Validate collection on real sources
   before declaring the engine ready for the UI.
5. **UI last (latest user instruction).** Render faithful sections/full description, Apply,
   consistent compensation, narrow exclusions and graduation ordering; remove legacy
   eligibility badges. Keep source internals out of the UI and list navigation intact.
   Then resume measured source expansion.

### Implementation checkpoint — September 6, 2026

Collection and local extraction are implemented, with operational evaluation outstanding:

- Complete description serialization and structured HTML normalization; complete Lever,
  SmartRecruiters, Ashby and Workday assembly. Dedupe preserves richer duplicate evidence.
- Persistent public collection queue: exact ATS identity, 200-detail run budget, oldest
  attempts first, refresh after 72 hours, exponential failure backoff, retained stale text,
  explicit acquisition status/version. Stable descriptions do not gain feed timestamps.
- First-party fallback accepts uniquely matched JobPosting JSON-LD on the posting URL,
  respects robots.txt, and declines redirects, disallowed domains and ambiguous pages.
  Generic-page heuristics are not certified as full descriptions.
- Local exact-offset responsibility/required/preferred/authorization/timing passages,
  structured and textual pay (currency, period, separate tiers/components), and mandatory
  graduation windows. Full original normalized text remains available. A shared pay label
  formatter handles missing, unavailable and ambiguous pay consistently.
- Narrow authorization assessment controls runtime classification/scoring/notifications.
  Missing, partial, stale or legacy-unverified descriptions cannot justify exclusion.
  Generic sponsorship labels do not create eligibility claims or ranking bonuses.
  Graduation uses stable partitioning, not rejection. UI wiring remains the final step.
- Schema 8 stores local details/evidence and profile-specific assessment, rebuilt on
  content, acquisition, source-pay, profile or extractor changes. Saved applications and
  notes survive; prior classifications/scores are invalidated. Routine per-user ATS
  prefetch is removed from sync; public collection supplies the shared descriptions.
- Classifier version 3 uses section scope so preferred qualifications and company text
  cannot become job duties. Department evidence resolves 12 more titles on the unchanged
  snapshot: 359 unresolved of 4,305 (8.34%), not a measured accuracy percentage.

The isolated backfill tool is `python -m poller.tools.enrich_descriptions`; its default
inventory is offline. Add `--live --limit 200 --output .tmp/description-backfill` for a
bounded source run in a network-enabled environment. It writes separate feed/shards,
state and report, without overwriting the input or publishing. Repeat with the same
output to resume the queue. Current inventory: 4,305 active, zero public descriptions,
2,653 known ATS URLs resolvable with validated paths. Additional custom-domain records
need provider identity or supported first-party data; resolution is not fetch success.

Live HTTP requests in this session were blocked by the execution environment (Windows
socket error 10013). Browser access also required unavailable approval. A few employer
page excerpts were inspected through web research and two small pay regressions added;
they do not establish full-page or multi-provider accuracy. No live backfill, deployment,
workflow restart or public feed update has occurred. The UI has deliberately not changed.

Release gate: run the backfill; inspect failures and full-document acquisition across all
five supported ATS families and first-party pages; review a separately labeled sample
across role families; record section precision/recall, pay accuracy, false exclusions and
graduation demotions. Measure real shard size and app cache latency. Only then implement
the final UI. Automated fixtures are regression evidence, not universal accuracy proof.

Tests must cover long-description ending clauses, encoded HTML, lists, required versus
preferred, negations and exceptions, multiple pay tiers/periods, no policy versus fetch
failure, year-only graduation profiles, excluded-job inspection, offline cache retention,
and stable feed output. Offline suites use fixtures, not live employer requests.

## Previous expansion work and retained backlog

The former Blocks 0–10 are retired as the active sequence, not declared universally
complete. The original plan is archived locally at
`.claude/plans/expansion-phase.pre-job-details-2026-09-06.md`; the old entry point links here.
The repository already contains infrastructure, ATS adapters, discovery, hot-watch,
generic extraction, dedupe, adaptive scheduling, classification, Gmail, and sharding work.
Historic implementation claims do not substitute for operational validation.

Carry forward: measured feed-size/request-cost baselines; live discovery yield and human
candidate promotion; first-party employer coverage and unsupported-source records;
directory integrations; Personio/USAJOBS/Gem prerequisites; hot-watch end-to-end checks;
seasonality and conditional-cache measurements; dedupe sampling; posting lifecycle/stale
season handling; and storage/history growth measurements. Expand beyond tech and include
small startups through repeatable discovery, not an aerospace-only hardcoded company list.

Outcome recalibration, additional expansion actions, hosted/accounts direction, and other
post-MVP proposals in the archive remain deferred. They are not prerequisites or new
authorization to override current architecture. No production poller restart/deployment
is implied by editing this plan.

## Research basis

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html)
- [Lever Postings API](https://github.com/lever/postings-api)
- [Ashby public postings](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [SmartRecruiters posting objects](https://developers.smartrecruiters.com/docs/objects)
- [JobPosting structured data](https://developers.google.com/search/docs/appearance/structured-data/job-posting)

Baseline examined during planning: September 5 public snapshot, 4,305 active postings,
zero published descriptions, 14 compensation values, and 539 top-level departments.
Private app caches were not measured. Of 371 unresolved role classifications, 124 had
departments, not necessarily informative ones. These are baselines, not promised gains.
