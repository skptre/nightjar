import { extractEvidence } from '../details/sections';
import type { CategoryResult, CategoryValue } from './types';
import { normalizeCategoryValue } from './types';
import { CLASSIFICATION_VERSION, type DomainValue, type EvidenceSource, type RoleEvidence } from './role-taxonomy';
import vocabulary from './role-rules.json';
import rules from './rules.json';

export interface RoleContext {
  company?: string;
  department?: string;
  occupational_category?: string;
}
interface Match {
  category: CategoryValue;
  rule: string;
  priority: number;
  source: EvidenceSource;
  text: string;
  start: number;
  end: number;
}

function normalize(text: string): string {
  // Preserve parenthetical specialties, normalize punctuation and Unicode dashes.
  return text.normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function expression(text: string): RegExp {
  return new RegExp(`\\b${normalize(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
}
const compiledRules = vocabulary.flatMap(group => group.phrases.map(phrase => ({
  category: group.category as CategoryValue,
  rule: phrase.text,
  priority: phrase.priority,
  pattern: expression(phrase.text),
})));

const domainRules: ReadonlyArray<{ value: DomainValue; pattern: RegExp }> = [
  { value: 'aerospace', pattern: /\b(aerospace|aeronautic\w*|aerodynamic\w*|avionics|spacecraft|satellites?|orbital|astrodynamics|flight|launch vehicle|launch and test|launch test|rocket\w*|gnc|propulsion)\b/ },
  { value: 'quant', pattern: /\b(quant(?:itative)?|systematic trading|algorithmic trading|high frequency trading|hft|market mak(?:ing|er)|trading (?:systems|technology|infrastructure|desk)|trader|strats|alpha research|derivatives pricing|options pricing)\b/ },
  { value: 'finance', pattern: /\b(financ(?:e|ial)|banking|bank|investment|asset management|wealth|credit|insurance|treasury|actuarial|trading)\b/ },
  { value: 'robotics', pattern: /\b(robot(?:ics|ic)?|robots|mechatronics|autonomous systems)\b/ },
  { value: 'semiconductors', pattern: /\b(semiconductor\w*|silicon|asic|fpga|vlsi|rtl|chip design|physical design|design verification)\b/ },
  { value: 'healthcare', pattern: /\b(healthcare|health care|medical|biomedical|biotech\w*|pharma\w*|clinical|patient|life sciences|genomics|bioinformatics)\b/ },
  { value: 'energy', pattern: /\b(energy|oil and gas|petroleum|solar|wind turbine|nuclear|renewable|electric grid|gas turbine)\b/ },
  { value: 'automotive', pattern: /\b(automotive|automobile|autonomous driving|self driving|electric vehicle|powertrain)\b/ },
];

function findRoles(text: string, source: EvidenceSource): Match[] {
  const normalized = normalize(text);
  const matches: Match[] = [];
  for (const rule of compiledRules) {
    rule.pattern.lastIndex = 0;
    for (const hit of normalized.matchAll(rule.pattern)) {
      matches.push({ category: rule.category, rule: rule.rule, priority: rule.priority,
        source, text, start: hit.index, end: hit.index + hit[0].length });
    }
  }
  // A phrase owns its span: 'product design' isn't product management; 'equity
  // research' isn't a generic research role. Separate nonoverlapping roles survive.
  const specific = matches.filter(match => !matches.some(other =>
    other !== match && other.start <= match.start && other.end >= match.end
    && other.end - other.start > match.end - match.start));
  // Research titles must retain their specialization even when a generic phrase
  // overlaps only part of it ('equity research' + 'research intern').
  const specializedResearch = /\b(equity research|ux research|user experience research|quantitative research|quant research)\b/.test(normalized);
  let resolved = specific.filter(match => !(specializedResearch && match.category === 'research')).filter(match => !(match.rule === 'assurance intern' && /quality assurance/.test(normalized)));
  // These activities alone don't establish a profession in a duties paragraph.
  if (source === 'description') {
    resolved = resolved.filter(match => !['operations', 'laboratory', 'product design'].includes(match.rule));
  }
  if (resolved.some(match => match.category === 'quant')) {
    resolved = resolved.filter(match => match.category !== 'research');
  }
  const businessHead = resolved.some(match => /(?:program|project) manage(?:r|ment)|recruit(?:er|ing|ment)|product manage(?:r|ment)/.test(match.rule));
  if (businessHead) resolved = resolved.filter(match => !['swe', 'hardware', 'mechE', 'ECE', 'aero'].includes(match.category));
  const hasSoftware = resolved.some(match => match.category === 'swe');
  if (hasSoftware) {
    resolved = resolved.filter(match => !['quant', 'aero'].includes(match.category));
    if (/\bhardware in (?:the )?loop\b/.test(normalized)) {
      resolved = resolved.filter(match => match.rule !== 'hardware');
    }
  }
  // These modifiers describe the application of an explicitly named job.
  if (resolved.some(match => !['quant', 'aero', 'research'].includes(match.category))) {
    resolved = resolved.filter(match => !(match.category === 'quant' && /trading|finance/.test(match.rule)));
  }
  if (resolved.some(match => ['product', 'marketing', 'sales', 'people', 'legal'].includes(match.category))) {
    resolved = resolved.filter(match => !['software', 'hardware', 'mechanical', 'electrical', 'electronics'].includes(match.rule));
  }
  return resolved.sort((a, b) => b.priority - a.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
}

// Only job-duty sentences may supplement a title. Company descriptions, degree
// lists, qualifications, and collaboration partners are not the candidate's work.
function dutySentences(description: string | null): string[] {
  if (!description) return [];
  const plain = description.replace(/<[^>]*>/g, '\n');
  return extractEvidence(plain).filter(p => p.section === 'responsibilities')
    .flatMap(p => p.text.split(/[\n.!?;]+/)).map(text => text.trim()).filter(text => {
    if (/\b(?:we (?:build|develop|design|serve|provide)|our team|will not|won't|does not)\b/i.test(text)) return false;
    if (/\b(qualifications?|requirements?|degree|major(?:s|ing)?|bachelor|master|phd|experience (?:in|with)|familiarity|knowledge of|equal opportunity|we are|our company|work (?:with|alongside)|collaborat\w*|partner with)\b/i.test(text)) return false;
    // A Job Description heading also contains employer prose. Require the candidate
    // or an imperative action as the subject, not just an action word anywhere.
    if (!/^(?:[-•*]\s*)?(?:you(?:'ll| will)|your (?:responsibilities|duties)\b|as\b[^.!?]*\byou(?:'ll| will)|(?:this|the) (?:role|position)\b|(?:develop|build|design|implement|train|analy[sz]e|research|test|maintain|support|create|conduct|perform|optimi[sz]e|work|assist|contribute|manage|monitor|drive|ensure|generate|issue|help|learn|gain|participate)\b)/i.test(text)) return false;
    return /\b(?:you will|you'll|work on|responsibilit\w*|duties|(?:develop|build|design|implement|train|analy[sz]e|research|test|maintain|support|create|conduct|perform|optimi[sz]e)(?:ing)?)\b/i.test(text);
  });
}

// Explicit self-description supplies employer field only, never candidate duties.
// Keep this distinct in evidence so consumers can distinguish employer context
// from work directly involving the domain. Customer lists don't establish it.
function employerFields(description: string | null, company?: string): Array<{text:string;source:EvidenceSource}> {
  if (!description) return [];
  return extractEvidence(description).filter(p => p.section === 'company' || p.section === 'other')
    .flatMap(p => p.text.split(/(?<=[.!?])\s+/)).filter(text => {
      let normalized = normalize(text);
      if (company && normalized.startsWith(`${normalize(company)} is `)) {
        normalized = `we are ${normalized.slice(normalize(company).length + 4)}`;
      }
      return /^(?:we are|our company is) (?:an? |the )?(?:leading |global )?(?:aerospace|quantitative trading|systematic trading|semiconductor|biotechnology|pharmaceutical|automotive|renewable energy|financial services) (?:company|firm|manufacturer|organization)\b/i.test(normalized)
        && !/\b(?:not|customers?|clients?|partners?|serving)\b/i.test(normalized);
    })
    .map(text => ({ text, source: 'employer' as const }));
}

function roleEvidence(match: Match): RoleEvidence {
  return { axis: 'role', value: match.category, source: match.source, text: match.text, rule: match.rule };
}

export function classifyCategory(
  title: string,
  description: string | null,
  simplifyCategory?: string,
  context: RoleContext = {},
): CategoryResult {
  const duties = dutySentences(description);
  const titleMatches = findRoles(title, 'title');
  if (!titleMatches.length) {
    const standalone = /\b(?:aerospace|avionics|quant|quantitative)\b/.exec(normalize(title));
    if (standalone) titleMatches.push({category: /quant/.test(standalone[0]) ? 'quant' : 'aero',
      rule: standalone[0], priority: 0, source: 'title', text: title,
      start: standalone.index, end: standalone.index + standalone[0].length});
  }
  const occupationMatches = context.occupational_category ? findRoles(context.occupational_category, 'occupation') : [];
  const departmentMatches = context.department ? findRoles(context.department, 'department') : [];
  const dutyMatches = duties.flatMap(text => findRoles(text, 'description'));
  let matches = titleMatches.length ? titleMatches
    : occupationMatches.length ? occupationMatches
      : dutyMatches.length ? dutyMatches : departmentMatches;
  // A generic research title leaves its specialization to explicit duties.
  if (titleMatches.length && titleMatches.every(match => match.category === 'research')) {
    const specialized = dutyMatches.filter(match => !['research', 'other'].includes(match.category));
    if (specialized.length) matches = specialized;
  }
  const categoryMap: Record<string, string> = rules.simplify_category_map;
  const sourceKey = Object.keys(categoryMap).find(key => normalize(key) === normalize(simplifyCategory ?? ''));
  const mapped = sourceKey ? normalizeCategoryValue(categoryMap[sourceKey]) : null;
  const warnings: string[] = [];
  if (simplifyCategory && !mapped) warnings.push(`Unmapped source category: ${simplifyCategory}`);
  if (mapped && matches.length && !matches.some(match => match.category === mapped)) warnings.push(`Source category disagrees: ${simplifyCategory}`);
  if (!matches.length && mapped && mapped !== 'other') {
    matches = [{category:mapped, rule:`simplify:${simplifyCategory}`, priority:0, source:'source-category', text:simplifyCategory!, start:0, end:0}];
  }
  const evidence = matches.map(roleEvidence);
  // Domain evidence needs posting context, never a hardcoded employer list.
  const domainInputs: Array<{text:string;source:EvidenceSource}> = [
    {text:title,source:'title'}, ...duties.map(text => ({text,source:'description' as const})),
    ...(context.department ? [{text:context.department,source:'department' as const}] : []),
    ...employerFields(description, context.company),
  ];
  const domainTags: DomainValue[] = [];
  for (const rule of domainRules) {
    const input = domainInputs.find(input => {
      const text = normalize(input.text);
      if (rule.value === 'aerospace' && /\bflight (?:tickets?|bookings?|discounts?|benefits?)\b/.test(text)) {
        return rule.pattern.test(text.replace(/\bflight (?:tickets?|bookings?|discounts?|benefits?)\b/g, ''));
      }
      return rule.pattern.test(text);
    });
    if (input) {
      domainTags.push(rule.value);
      evidence.push({axis:'field',value:rule.value,source:input.source,text:input.text,rule:normalize(input.text).match(rule.pattern)![0]});
    }
  }
  if (mapped === 'quant') {
    if (!domainTags.includes('quant')) domainTags.push('quant');
    evidence.push({axis:'field',value:'quant',source:'source-category',text:simplifyCategory!,rule:`simplify:${simplifyCategory}`});
  }
  if (!domainTags.includes('quant')) {
    const quantRole = matches.find(match => match.category === 'quant');
    if (quantRole) {
      domainTags.push('quant');
      evidence.push({...roleEvidence(quantRole), axis:'field', value:'quant'});
    }
  }
  const primary = matches[0];
  const tags = [...new Set(matches.map(match => match.category))];
  return {
    version: CLASSIFICATION_VERSION,
    category: primary?.category ?? 'other',
    category_tags: tags.length ? tags : ['other'],
    domain_tags: domainTags,
    confidence: !primary ? 'unknown' : primary.source === 'title' ? 'high' : primary.source === 'source-category' ? 'low' : 'medium',
    evidence, warnings,
    matched_rule: primary?.rule ?? null,
    matched_in: primary?.source === 'title' || primary?.source === 'description' ? primary.source : null,
  };
}
