# Role classification and the September 2026 audit

Nightjar separates the work performed from the field it serves. Industry context must not make an avionics software internship appear as aerospace engineering work.

| Selection | Results |
|---|---|
| Role: SWE; any field | Software roles, including aerospace and quant software |
| Role: SWE; field: Aerospace | Aerospace software |
| Role: Aerospace Engineering; any field | Core aerospace engineering, excluding software-only work |
| Any role; field: Quant finance | Quant research, trading, software and other supported work |
| Role: Hardware; field: Quant finance | Hardware roles with quant evidence, including FPGA trading systems |

Selections are OR within a dimension and AND between dimensions. No compatibility blacklist is used. Role preferences in existing profiles remain alternatives; the feed has separate temporary field refinements. Quant research/trading is a work role; Quant finance is a field.

## What went wrong

The committed classifier combined work and industry into one tag array, and filters accepted any matching tag. Changing the primary display label could not fix membership in the Aerospace filter. Description keywords and generic robotics tags also added professions without evidence that the intern would perform that work.

Source labels had drifted: the actual feed used `Software`, `Hardware`, `AI/ML/Data`, `Quant`, and `Product`, while the fallback dictionary largely expected longer names. These postings were present in the public feed; classification left many under Other. Vendor labels are imperfect too: the snapshot contains contracts work labeled AI/ML/Data and gas-turbine engineering labeled Software. Explicit work evidence must take precedence.

## Reproducible snapshot

- Public snapshot timestamp: `2026-09-05T03:51:52Z`.
- SHA-256: `cc1795a21420d4796ff93d9560401e9039ca035fba21e9d30edd9b95eb79688a`.
- Denominator: 4,305 active postings; closed records excluded consistently.
- Inputs: public title, available description text, source category, department and occupational text. No private cached descriptions or profiles.

| Engine | Unclassified | Share |
|---|---:|---:|
| Committed engine at `ff52631` | 2,037 | 47.32% |
| Claude's uncommitted rewrite at session start | 1,477 | 34.31% |
| Work/field engine | 371 | 8.62% |

The original 47% figure is reproducible. The quoted 1,343 lost postings is not reproduced exactly on this snapshot: 1,379 of the committed engine's unknowns carry an unmapped source category. This is a classification gap, not evidence of deleted postings or failed source acquisition.

The new engine assigns 3,153 postings from title evidence and 781 from lower-confidence source fallbacks. All source category labels in this snapshot are recognized. There are 597 source/title disagreements queued for inspection; some are broad source buckets versus more specific Nightjar roles, not necessarily vendor errors. Do not interpret an 8.62% unknown rate as 91.38% accuracy. Confidence labels identify evidence strength, not measured probabilities.

Run from `app`:

```sh
npm run audit:classification
# Pure JSON, suitable for redirecting to a local review file:
node scripts/classification-audit.mjs ../data/feed.json
```

The report contains the exact feed hash, per-source counts, role/field distributions, confidence, conflicts and a review queue. It does not alter the feed or call the network. The 72 reviewed titles in `role-corpus.test.ts` run both alone and with misleading company/qualification boilerplate (144 checks). These and the dedicated role/filter regressions are regression coverage, not an independently sampled production benchmark.

## Evidence and maintenance

`role-rules.json` owns phrase vocabulary. Matching preserves parentheses, uses token boundaries, and resolves overlapping phrase spans. Specialized research stays specialized; software and recruitment/program management are distinguished from the team or domain named in the title. A specific title controls its work tags. For vague titles, occupational text, duty sentences, department, then vendor labels provide fallback evidence. The engine excludes company summaries, degree lists and collaboration sentences from duty evidence.

The complete result, its evidence, source disagreements and version are stored locally. Existing cached rows are reclassified offline once per engine version, including closed rows; application state and notes are preserved. Increment `CLASSIFICATION_VERSION` for subsequent released vocabulary or semantic changes. Fields never become work tags simply to make a combination return results.

The design uses the distinction between occupations and contextual information reflected in [BLS classification by duties](https://www.bls.gov/soc/finding_soc_code.htm) and the [O*NET content model](https://www.onetcenter.org/content.html). Nightjar's lightweight rules are not an implementation of SOC or O*NET and do not claim their coverage.

## Limits and the next phase

Unknowns still include generic titles such as Systems Engineer, Engineering Intern and Summer Intern, plus unsupported specialties. Source-only estimates can be wrong. Duty extraction is conservative and rule based; it cannot understand every description or distinguish every ambiguous occupation. Missing field evidence means a posting will not match a field refinement; clearing the field filter restores the broader role results.

Before claiming production precision/recall, label a source-stratified sample, including unresolved postings and source/title conflicts, and keep a separate evaluation holdout. Measure each role and field independently and test filter retrieval, not only the primary label.

Collection coverage is the next phase. Classification cannot produce NASA or startup internships that are absent from the feed. The audit's per-source unresolved counts establish a baseline for improving description/department enrichment and measuring discovery yield across industries. Source acquisition and registry changes are intentionally outside this classification change.
