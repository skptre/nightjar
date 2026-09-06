import type { AcquisitionStatus, JobDetails } from './types';
import { extractCompensation } from './pay';
import { extractGraduation } from './graduation';
import { extractEvidence } from './sections';
export { extractEvidence } from './sections';

export const DETAILS_VERSION = 1;
const AUTH = /\b(?:citizens?(?:hip)?|work authori[sz]ation|authori[sz]ed to work|sponsor(?:ship|ing)?|visas?|CPT|OPT|F[ -]?1|ITAR|EAR|export control|U\.?S\.? persons?|permanent residents?|security clearance)\b/i;
const PAY = /(?:[$£€]|\b(?:USD|CAD|GBP|EUR|salary|compensation|stipend|hourly (?:pay|rate)|base pay)\b)/i;

export function extractJobDetails(document: string | null, options: {
  acquisition?: AcquisitionStatus; structuredCompensation?: unknown; advertisedCompensation?: string;
} = {}): JobDetails {
  const text = document ?? '';
  const evidence = extractEvidence(text);
  const sections: JobDetails['sections'] = { responsibilities: [], required: [], preferred: [],
    authorization: [], compensation: [], timing: [], company: [], other: [] };
  for (const passage of evidence) sections[passage.section].push(passage);
  const authorization = evidence.filter(p => AUTH.test(p.text));
  const payPassages = evidence.filter(p => PAY.test(p.text) && p.section !== 'company');
  const acquisition = options.acquisition ?? 'unknown';
  const compensation = extractCompensation(payPassages, acquisition, options.structuredCompensation,
    options.advertisedCompensation);
  return { version: DETAILS_VERSION, document: text, acquisition, sections, authorization,
    compensation, graduation: extractGraduation(evidence) };
}
