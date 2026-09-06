import type { Profile } from '@/profile/types';
import type { JobDetails, RequirementAssessment } from './types';
import { graduationBounds } from './graduation';

const EXCEPTION = /\b(?:unless|except(?:ion)?s?|case[- ]by[- ]case|waiv(?:er|ed)|or eligible to obtain|may be (?:approved|considered))\b/i;
const NEGATION = /\b(?:citizenship (?:is )?not required|citizens? (?:are )?not required|not (?:be |a )?(?:US )?citizen|not limited to|do not discriminate|regardless of)\b/i;
const CITIZEN_ONLY = /\b(?:US citizenship (?:is )?(?:required|mandatory)|(?:applicants|candidates|you) must be (?:an? )?US citizens?|(?:open|limited|restricted) (?:only )?to US citizens?|only able to hire US citizens?)\b/i;

export function assessRequirements(details: JobDetails, profile: Profile): RequirementAssessment {
  const result: RequirementAssessment = { exclude: false, exclusionEvidence: [],
    outsideGradWindow: false, graduationEvidence: [] };
  // A stale, partial, or unverified legacy document cannot justify hiding an opportunity.
  if (details.acquisition !== 'available') return result;
  const knownNoncitizen = ['f1_opt_cpt', 'f1_cpt', 'f1_opt', 'f1_stem_opt', 'h1b', 'permanent_resident'].includes(profile.work_auth);
  const student = profile.work_auth.startsWith('f1');
  for (const evidence of details.authorization) {
    const text = evidence.text.replace(/U\.S\./gi, 'US').replace(/F[- ]1/gi, 'F1');
    const context = details.document.slice(Math.max(0, evidence.start - 100), evidence.end + 350);
    if (evidence.section === 'preferred' || evidence.section === 'company' || text.includes('?')
        || /\bpreferred\b/i.test(text) || EXCEPTION.test(context) || NEGATION.test(text)) continue;
    // Alternatives are not equivalent to citizens-only. Leave compound status rules visible.
    const citizensOnly = knownNoncitizen
      && (CITIZEN_ONLY.test(text) || /^(?:[-•*]\s*)?US citizens? only[.!]?$/i.test(text.trim())
        || /(?:^|[.!?]\s+)(?:[-•*]\s*)?(?:must be (?:an? )?US citizen|this (?:position|role) requires US citizenship)\b/i.test(text))
      && !/\b(?:or|permanent residents?|protected individuals?|US persons?)\b/i.test(text)
      && !/\bpermanent residents?\b[^.!?\n]{0,60}\b(?:eligible|welcome|accepted)\b/i.test(context);
    const rejectsF1 = student && (
      /\bF1\b(?: (?:visa|visas|students?|holders?|applicants?|candidates?|status|are|is|will|be)){0,7} (?:not (?:eligible|accepted|supported)|ineligible)\b/i.test(text)
      || /\b(?:do not|cannot|unable to) (?:accept|support|hire) (?:applicants |candidates |students )?(?:(?:on|with|using) )?(?:an? )?F1\b/i.test(text));
    const rejectsTraining = student && /\b(?:do not|cannot|can't|unable to) (?:accept|support|hire)\b[^.!?\n]{0,100}\b(?:CPT\b[^.!?\n]*\bOPT|OPT\b[^.!?\n]*\bCPT)\b/i.test(text)
      && !/\b(?:CPT|OPT)\b[^.!?\n]{0,50}\b(?:welcome|eligible|accepted)\b/i.test(context);
    const path = profile.authorization_path;
    const pathName = path === 'cpt' ? 'CPT' : path === 'opt' ? '(?<!STEM )OPT' : path === 'stem_opt' ? 'STEM[ -]OPT' : null;
    const rejectsPath = student && pathName !== null && new RegExp(`\\b(?:do not|cannot|unable to) (?:accept|support|hire) (?:candidates (?:on|using) )?${pathName}\\b`, 'i').test(text);
    if (citizensOnly || rejectsF1 || rejectsTraining || rejectsPath) result.exclusionEvidence.push(evidence);
  }
  result.exclude = result.exclusionEvidence.length > 0;
  const date = graduationBounds(profile.graduation);
  if (date && details.graduation.length) {
    // Multiple windows are treated as alternatives. Only disjointness from all proves mismatch.
    const compatible = details.graduation.some(w => date[0] <= w.end && date[1] >= w.start);
    if (!compatible) {
      result.outsideGradWindow = true;
      result.graduationEvidence = details.graduation.map(w => w.evidence);
    }
  }
  return result;
}

export function orderByRequirements<T extends { assessment: RequirementAssessment }>(
  rows: readonly T[], showExcluded = false,
): T[] {
  const kept = rows.filter(row => showExcluded || !row.assessment.exclude);
  return [...kept.filter(row => !row.assessment.outsideGradWindow),
    ...kept.filter(row => row.assessment.outsideGradWindow)];
}
