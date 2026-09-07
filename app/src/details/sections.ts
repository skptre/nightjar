import type { Evidence, SectionKind } from './types';

const HEADINGS: Array<[SectionKind, RegExp]> = [
  ['other', /^(?:additional information|identity statement|candidate AI usage policy|work model|professional development)$/i],
  ['preferred', /^(?:preferred(?: qualifications| requirements| skills| experience)?|nice[- ]to[- ]haves?|nice if you have|bonus(?: points)?|what (?:would|will) make you stand out|desired qualifications)$/i],
  ['required', /^(?:(?:basic|minimum|required|essential) (?:qualifications|requirements|skills)|qualifications|requirements|what (?:you(?:'ll| will)? need|we(?:'re| are) looking for)|who you are|what you bring|you have|your background|skills you(?:'ll| will) need to bring)$/i],
  ['responsibilities', /^(?:responsibilities|(?:your|the) (?:role|impact|responsibilities)|(?:key|job) responsibilities|what you(?:'ll| will) do|what you(?:'ll| will) (?:work on|be doing)|about (?:the|this) role|duties|job description|role description|what you(?:'ll| will) achieve)$/i],
  ['authorization', /^(?:authorization|work authorization|visa sponsorship|(?:export|export control) compliance|(?:citizenship|security clearance) requirements|immigration)$/i],
  ['compensation', /^(?:compensation(?: and benefits)?|salary(?: range)?|pay(?: range)?|benefits(?: and perks)?|what we offer|what you(?:'ll| will) (?:gain|get))$/i],
  ['timing', /^(?:internship dates|program dates|duration|availability|application deadline)$/i],
  ['company', /^(?:company description|about us|about (?:the company|[\w -]{1,45})|who we are|our (?:company|mission|team)|equal (?:employment )?opportunity(?: employer)?)$/i],
];
const REQUIRED_SENTENCE = /\b(?:must|required|minimum|need to|shall|only (?:applicants|candidates)|eligible applicants)\b/i;
const PREFERRED_SENTENCE = /\b(?:preferred|nice[- ]to[- ]have|a plus|bonus points|ideally)\b/i;
const DUTY = /^(?:[-•*]\s*)?(?:you(?:'ll| will)|(?:design|develop|build|implement|analyze|test|support|conduct|assist|research|collaborate|maintain|create|perform|work)\b)/i;

function heading(line: string): { kind: SectionKind; length: number } | null {
  const prefix = line.match(/^\s*(?:#{1,6}\s*)?([^:]{1,90})(?::\s*|$)/);
  if (!prefix?.[1]) return null;
  const title = prefix[1].trim().replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
    .replace(/[’‘]/g, "'");
  for (const [kind, pattern] of HEADINGS) if (pattern.test(title)) return { kind, length: prefix[0].length };
  if (/^[A-Z][A-Za-z &/()-]{1,65}:\s*$/.test(line)) return { kind: 'other', length: line.length };
  return null;
}

export function extractEvidence(document: string): Evidence[] {
  const evidence: Evidence[] = [];
  let section: SectionKind = 'other';
  let start: number | null = null;
  let end = 0;
  const flush = (): void => {
    if (start === null || end <= start) { start = null; return; }
    const text = document.slice(start, end);
    let kind = section;
    if (PREFERRED_SENTENCE.test(text) && kind !== 'company') kind = 'preferred';
    else if (kind === 'other' && DUTY.test(text)) kind = 'responsibilities';
    else if (kind === 'other' && REQUIRED_SENTENCE.test(text)) kind = 'required';
    evidence.push({ text, start, end, section: kind });
    start = null;
  };
  for (const match of document.matchAll(/[^\n]+|\n/g)) {
    const line = match[0];
    const index = match.index;
    if (line === '\n') continue;
    const prior = document.slice(end, index);
    const label = heading(line);
    if (label) {
      flush(); section = label.kind;
      const remainder = line.slice(label.length).trim();
      if (remainder) { start = index + line.indexOf(remainder, label.length); end = index + line.trimEnd().length; }
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const standaloneBullet = start !== null && /^[-•*]$/.test(document.slice(start, end));
    if ((prior.includes('\n\n') && !standaloneBullet) || /^\s*[-•*](?:\s|$)/.test(line)) flush();
    if (start === null) start = index + line.search(/\S/);
    end = index + line.trimEnd().length;
  }
  flush();
  return evidence;
}

