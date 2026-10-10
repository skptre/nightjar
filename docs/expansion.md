# Nightjar expansion: requirements and coverage roadmap

> Status reviewed October 9, 2026. This is a requirements roadmap, not a list of
> completed UI features. Use the current app source for the implemented
> screens. Historical acquisition results are in the
> [September release checkpoint](description-release-v5.md); older network-blocked
> results do not describe the current tree or current network availability.

Collection, local evidence extraction and description rendering are implemented.
The current UI uses inline highlights and a full-description sheet, with separate
Roles/Fields filters. Some proposals below remain gaps: a dedicated Show excluded
control, Outside grad window ordering/tag, and evidence-aware Pay unavailable / Pay
not listed copy are not present in the current UI. All jobs provides broader
browsing; saved applications remain distinct from the public catalog.

The original direction dates to September 6, 2026. Requirements below preserve
that intent where not superseded by the current UI; they must not be reported as
implemented without checking the source and testing the behavior. No fresh
coverage benchmark or runtime testing was performed for this documentation update.

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

### Recovery checkpoint — September 7, 2026

The committed work and Claude's isolated backfill survived the restart. The recovered
run has 12 descriptions from 20 attempts across the five original ATS families.
[The recovery audit](description-evaluation.md) records exact hashes, findings,
validation, and remaining release gates; it supersedes the earlier statement that no
live backfill existed.

Acquisition version 3 completes guarded Workable detail assembly, structured-page
fallback for iCIMS/JazzHR/Rippling, shared URL detection, and known-board Greenhouse
resolution. It rejects listing teasers/whole-page HTML, avoids guessed board identities,
invalidates retries when a board changes, and marks overdue queued content stale.
The backfill tool uses the same resolution rules and reports provider outcomes/errors
and payload sizes. Offline resolvable targets increase from 2,653 to 3,009 of 4,305.

Details version 2 handles reviewed heading and repeated-pay-unit variants and keeps
paragraph-wrapped bullets intact. Classification version 4 rejects employer recruiting
prose as duties and fixes hardware-in-the-loop software role membership. The new
`npm run audit:details -- <feed>` command produces an offline evidence review report.

All local checks pass (1,120 Python tests, 1,073 app tests, lint/types/build).
Live networking remains blocked in this session, so wider collection and a separately
labeled evaluation remain outstanding. The final UI is still gated on that evaluation.

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










9/7/2026 classifier + description extractor proposal:


I’d build a shared system that takes a job URL, finds the employer’s    
  actual document, checks that it belongs to the right job, preserves it, 
  and keeps it current. Every posting would have either a usable          
  description or a specific, actionable reason collection hasn’t          
  succeeded.                                                              
                                                                          
  That is a larger system than we currently have. We can reuse the        
  existing work, but the completion criterion needs to become coverage and
  accuracy on real postings, rather than implemented adapters and passing 
  tests.                                                                  
                                                                          
  One boundary matters: no extractor can guarantee text from an expired   
  page, a login wall, or a page that refuses access. We can design for    
  broad automatic coverage and make those exceptions explicit.            
                                                                          
  Here is the design I recommend.                                         
                                                                          
  1. One URL-resolution layer, shared by every collection method          
                                                                          
  Before extracting anything, establish which job the URL represents.     
                                                                          
  It should handle regional ATS hosts, locale prefixes, application-page  
  suffixes, custom employer domains, embedded job boards, and ordinary    
  redirects. Preserve job-identifying query parameters and fragments;     
  remove only known tracking parameters.                                  
                                                                          
  Retain these separately:                                                
                                                                          
  - Original URL and Apply URL.                                           
  - Employer, provider, board and job identity.                           
  - Verified alternative URLs for the same posting.                       
                                                                          
  A matching title alone must never justify attaching a description—      
  companies reuse titles constantly. Exact provider IDs take precedence;  
  otherwise, matching needs corroborating employer and job-page evidence. 
                                                                          
  This addresses real gaps already in our feed, including Workable /apply 
  links and regional Greenhouse URLs.                                     
                                                                          
  2. Several extraction methods, with automatic fallback                  
                                                                          
  The collector should try the cheapest reliable method first, then       
  continue when the result is missing, incomplete, or mismatched.         
                                                                          
   Method                          What it retrieves                      
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Public ATS API                  Complete advertised description        
                                   fields, additional sections and        
                                   structured pay.                        
  ──────────────────────────────  ────────────────────────────────────────
   Structured page data            JobPosting JSON-LD, microdata, or job  
                                   data embedded in the page.             
  ──────────────────────────────  ────────────────────────────────────────
   Provider/template extraction    The job-description containers on      
                                   recurring employer-site layouts.       
  ──────────────────────────────  ────────────────────────────────────────
   General HTML extraction         The relevant document blocks on        
                                   unfamiliar employer pages.             
  ──────────────────────────────  ────────────────────────────────────────
   Job-document extraction         Text from a job PDF when that is the   
                                   actual posting.                        
                                                                          
  The first method is valuable: Greenhouse documents full descriptions    
  through its public API, while Lever explicitly separates additional     
  lists and closing content. We must assemble those fields deliberately.  
  Greenhouse documentation, Lever documentation.                          
                                                                          
  The important addition is general page extraction. Today, unfamiliar    
  pages largely depend on matching JSON-LD. That misses descriptions      
  available elsewhere in the document.                                    
                                                                          
  I would evaluate Trafilatura as a candidate generator, then apply       
  Nightjar’s job-specific checks. Its extraction modes explicitly trade   
  off retaining text against removing noise, so its output cannot itself  
  prove completeness. Trafilatura documentation.                          
                                                                          
  We should preserve the entire job document, including closing           
  restrictions and compensation. Selecting concise responsibilities and   
  qualifications happens afterward.                                       
                                                                          
  For example, a TikTok URL currently unresolved by our engine exposes    
  responsibilities, qualifications, compensation and closing clauses      
  through the research browser. That is a concrete collection target—not  
  proof that our collector already handles it. Example employer posting.  
                                                                          
  3. A validator decides whether an extraction is usable                  
                                                                          
  A successful request or a long string cannot mean “complete             
  description.”                                                           
                                                                          
  Each candidate must be checked for:                                     
                                                                          
  - Identity: Is this the requested job?                                  
  - Document boundaries: Did we capture the job rather than navigation, an
    application form, or recommended jobs?                                

  - Completeness: Did we retain all relevant source fields and document   
    blocks, including the ending?                                         
                                                                          
  - Freshness: When was this version successfully checked?                
                                                                          
  Where multiple representations exist, compare them. A short JSON-LD     
  description should not automatically beat a visibly fuller job document.
  Conversely, taking whichever candidate is longest could accidentally    
  include unrelated jobs.                                                 
                                                                          
  Track identity, completeness, freshness and fetch outcome separately. A 
  complete older copy remains useful after a failed refresh; it simply    
  becomes stale. Partial content can still be retained, but cannot justify
  “pay not listed” or an authorization exclusion.                         
                                                                          
  Completeness checks need source-specific contracts plus reviewed        
  examples. There is no universal word-count threshold that proves a      
  document is complete.                                                   
                                                                          
  4. Collection becomes a maintained queue, with an explicit coverage     
  backlog                                                                 
                                                                          
  New listings should appear promptly while description collection runs   
  separately. A slow employer must not hold up the entire feed.           
                                                                          
  The queue would prioritize new jobs, then failed or incomplete          
  acquisitions, while reserving capacity for refreshes. It would share    
  board responses, enforce host delays, respect backoff, and avoid        
  repeatedly hammering one broken source.                                 
                                                                          
  Every failure gets a reason: unresolved identity, unsupported template, 
  blocked request, missing content, ambiguous job, or unavailable page.   
  Group failures by provider/template and number of affected postings.    
                                                                          
  That gives us a rational implementation order. In the current unresolved
  inventory:                                                              
                                                                          
  - TikTok/ByteDance account for 318 postings.                            
  - Tesla accounts for 98.                                                
  - Other substantial groups share Oracle, SuccessFactors and employer-   
    site layouts.                                                         
                                                                          
  We should fix the largest reusable gaps while maintaining a separate    
  sample of smaller employers so coverage doesn’t become big-company-only.
                                                                          
  Robots handling also needs to distinguish a missing file from an        
  unreachable server; treating every robots error identically             
  unnecessarily loses coverage. Robots protocol.                          
                                                                          
  5. Publish descriptions separately, and cache them locally
                                                                          
  Keep the browsable feed lightweight. Publish complete documents in      
  small, versioned detail packs, referenced by content hash.              
                                                                          
  The app downloads changed packs in the background, stores them locally, 
  and recomputes extraction/classification only when the document or      
  engine version changes.                                                 
                                                                          
  A crucial requirement: background collection must cover the feed, not   
  just postings the user opens. Otherwise, unopened jobs would still have 
  poor classification and missing compensation, undermining filters.      
                                                                          
  Publish detail files before their manifest, verify hashes, and retain   
  the previous cache on interrupted downloads. Routine checks of unchanged
  text should not cause every user to download it again.                  
                                                                          
  The public side contains employer documents and source facts. Profile   
  comparisons and personal decisions stay local.                          
                                                                          
  6. One document powers the product’s interpretation                     
                                                                          
  The same preserved document supplies:                                   
                                                                          
  - Responsibilities, required and preferred qualifications.              
  - Compensation, including separate periods, currencies and conditions.  
  - Authorization passages and narrow explicit conflicts.                 
  - Graduation requirements and mismatch ordering.                        
  - Role and field classification.                                        
                                                                          
  Every extracted value points back to its original passage or structured 
  field. Ambiguous sections retain more context rather than receiving a   
  confident but incorrect label.                                          
                                                                          
  Classification should use the candidate’s duties, with title and        
  department as supporting evidence. Company activity, collaborators and  
  preferred skills must not become the candidate’s profession.            
                                                                          
  Model assistance can be evaluated later against demonstrated            
  classification gaps. It cannot recover text we never fetched, and it    
  should not generate the description or decide authorization exclusions. 
                                                                          
  The agreed expanded-row UI remains the final integration step: faithful 
  excerpts, full description, Apply, consistent compensation, and the     
  previously agreed exclusion/graduation behavior.                        
                                                                          
  7. Define “done” before implementation starts                           
                                                                          
  I propose these acceptance conditions:                                  

   Area                  Proposed requirement                             
  ━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Accountability        Every active posting has a recorded collection   
                         outcome.                                         
  ────────────────────  ──────────────────────────────────────────────────
   Automatic coverage    Target complete, identity-validated descriptions 
                         for at least 95% of all active feed postings.    
                         Blocked/unsupported jobs stay in the             
                         denominator.                                     
  ────────────────────  ──────────────────────────────────────────────────
   Correctness           No wrong-job attachments in the reviewed release 
                         set; measure missing material passages           
                         separately.                                      
  ────────────────────  ──────────────────────────────────────────────────
   Interpretation        Separately measure section selection, pay        
                         accuracy, role/field accuracy, false exclusions  
                         and graduation demotions.                        
  ────────────────────  ──────────────────────────────────────────────────
   Reliability           Failed refreshes preserve content; retries       
                         progress fairly; unchanged documents produce     
                         stable output.                                   
  ────────────────────  ──────────────────────────────────────────────────
   Delivery              Successfully backfill, publish, sync and read    
                         details offline in the actual app.               
                                                                          
  The 95% figure is a proposed target, not a claim that we can already    
  reach it. If measured results fall short, we present the actual         
  remaining blockers rather than silently changing the definition of      
  completion.                                                             
                                                                          
  Start with a reviewed corpus spanning providers, occupations, small     
  employers, malformed pages and failures. Keep a separate holdout split  
  by employer/template, so we aren’t merely testing layouts we tuned      
  against.                                                                
                                                                          
  The implementation order would be: corpus and baseline → resolver and   
  validator → extraction methods → full backfill and gap repair → reliable
  publication/cache → interpretation evaluation → UI integration.         
                                                                          
  For pages that only become readable in a user’s browser, an optional    
  “Import this job” action could capture the opened description locally.  
  Chrome supports temporary access following a user action. That would    
  supplement shared coverage, without publishing someone’s browsing       
  activity. Chrome documentation. Automated browser navigation would      
  require revisiting the current project ban; it is not an assumed        
  dependency of this design.
