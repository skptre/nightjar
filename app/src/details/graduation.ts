import type { Evidence, GraduationWindow } from './types';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const DATE = '(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+)?20\\d{2}(?:-(?:0[1-9]|1[0-2]))?';

function bounds(date: string): [string, string] {
  const iso = date.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (iso) return [date, date];
  const year = date.match(/20\d{2}/)?.[0] ?? '';
  const name = date.match(/^[A-Za-z]+/)?.[0]?.toLowerCase();
  const month = name ? MONTHS.findIndex(m => m.startsWith(name)) + 1 : 0;
  if (month) { const value = `${year}-${String(month).padStart(2, '0')}`; return [value, value]; }
  return [`${year}-01`, `${year}-12`];
}

function nextMonth(date: string, delta: number): string {
  const [year, month] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function extractGraduation(passages: Evidence[]): GraduationWindow[] {
  const windows: GraduationWindow[] = [];
  for (const evidence of passages) {
    const text = evidence.text;
    if (!/\bgraduat(?:e|es|ing|ion)\b/i.test(text) || evidence.section === 'company') continue;
    const mandatory = evidence.section === 'required' || /\b(?:must|required|shall)\b/i.test(text);
    if (!mandatory || evidence.section === 'preferred' || /\b(?:preferred|ideally|for example|e\.g\.|not required)\b/i.test(text)) continue;
    // Scope dates to the graduation clause rather than internship dates elsewhere in a paragraph.
    const clause = text.slice(text.search(/\bgraduat(?:e|es|ing|ion)\b/i));
    const match = clause.match(new RegExp(`^graduat(?:e|es|ing|ion)(?:\\s+date)?\\s*(?:is\\s+|of\\s+|expected\\s+)?(between|from|by|before|after|in|on or before|on or after)?\\s*(${DATE})(?:\\s*(?:and|to|through|[-–—])\\s*(${DATE}))?`, 'i'));
    if (!match?.[2]) continue;
    // Disjoint alternatives must not become a continuous range (2027 OR 2029).
    const alternative = clause.slice(match[0].length).match(new RegExp(`^\\s+or\\s+(${DATE})`, 'i'));
    if (alternative?.[1] && !match[3]) {
      for (const value of [match[2], alternative[1]]) {
        const [start, end] = bounds(value);
        windows.push({ start, end, evidence, mandatory: true });
      }
      continue;
    }
    const first = bounds(match[2]);
    const second = match[3] ? bounds(match[3]) : first;
    let start = first[0], end = second[1];
    const relation = match[1]?.toLowerCase();
    if (relation === 'by' || relation === 'on or before') start = '0000-01';
    if (relation === 'before') { start = '0000-01'; end = nextMonth(first[0], -1); }
    if (relation === 'after') { start = nextMonth(first[1], 1); end = '9999-12'; }
    if (relation === 'on or after') { start = first[0]; end = '9999-12'; }
    if ((relation === 'between' || relation === 'from') && !match[3]) continue;
    if (start <= end) windows.push({ start, end, evidence, mandatory: true });
  }
  return windows;
}

export function graduationBounds(value: string): [string, string] | null {
  return /^20\d{2}(?:-(?:0[1-9]|1[0-2]))?$/.test(value) ? bounds(value) : null;
}
