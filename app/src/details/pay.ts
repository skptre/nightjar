import type { AcquisitionStatus, Evidence, JobDetails, PayRange } from './types';

const PERIODS: Array<[PayRange['period'], RegExp]> = [
  ['hour', /\b(?:hour(?:ly)?|hr)s?\b/i], ['day', /\b(?:day|daily)s?\b/i],
  ['week', /\bweek(?:ly)?s?\b/i], ['month', /\bmonth(?:ly)?s?\b/i],
  ['year', /\b(?:year(?:ly)?|annual(?:ly)?|annum)s?\b/i],
];
function period(text: string): PayRange['period'] | null {
  return PERIODS.find(([, regex]) => regex.test(text))?.[0] ?? null;
}
function kind(text: string): PayRange['kind'] {
  if (/\b(?:stipend|housing|relocation)\b/i.test(text)) return 'stipend';
  if (/\bbonus\b/i.test(text)) return 'bonus';
  if (/\bequity\b/i.test(text)) return 'equity';
  if (/\b(?:base|salary|wage|hourly|pay)\b/i.test(text)) return 'base';
  return 'unspecified';
}
function amount(value: string): number {
  return Number(value.replace(/[,k]/gi, '')) * (/k$/i.test(value) ? 1000 : 1);
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function structuredEvidence(value: unknown, label = ''): Evidence {
  return { text: label || JSON.stringify(value), start: -1, end: -1, section: 'compensation' };
}
function structuredRanges(value: unknown): PayRange[] {
  const root = record(value), data = record(root['data']);
  const result: PayRange[] = [];
  const add = (item: Record<string, unknown>, min: unknown, max: unknown, currency: unknown,
    unit: unknown, type: string, label = ''): void => {
    const interval = typeof unit === 'string' ? period(unit) : null;
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min)
      || !Number.isFinite(max) || min < 0 || min > max || typeof currency !== 'string'
      || !/^[A-Z]{3}$/.test(currency) || !interval) return;
    result.push({ min, max, currency, period: interval, kind: kind(type),
      evidence: structuredEvidence(item, label), source: 'structured', ...(label ? { label } : {}) });
  };
  if (root['provider'] === 'lever') {
    const range = record(data['salaryRange']);
    add(range, range['min'], range['max'], range['currency'], range['interval'], 'base');
  } else if (root['provider'] === 'greenhouse' && Array.isArray(data['pay_input_ranges'])) {
    for (const raw of data['pay_input_ranges']) {
      const range = record(raw);
      const label = [range['title'], range['blurb']].filter(v => typeof v === 'string').join('\n');
      // Greenhouse's amounts are cents; its public field does not always state the period.
      add(range, typeof range['min_cents'] === 'number' ? range['min_cents'] / 100 : null,
        typeof range['max_cents'] === 'number' ? range['max_cents'] / 100 : null,
        range['currency_type'], label, 'base', label);
    }
  } else if (root['provider'] === 'ashby' && data['shouldDisplayCompensationOnJobPostings'] === true) {
    const comp = record(data['compensation']);
    const tiers = Array.isArray(comp['compensationTiers']) ? comp['compensationTiers'] : [];
    const groups = tiers.length ? tiers : [{ components: comp['summaryComponents'] }];
    for (const tierRaw of groups) {
      const tier = record(tierRaw);
      if (!Array.isArray(tier['components'])) continue;
      for (const raw of tier['components']) {
        const component = record(raw);
        add(component, component['minValue'], component['maxValue'], component['currencyCode'],
          component['interval'], String(component['compensationType'] ?? ''),
          typeof tier['title'] === 'string' ? tier['title'] : '');
      }
    }
  }
  return result;
}

export function extractCompensation(passages: Evidence[], acquisition: AcquisitionStatus,
  structured?: unknown, advertised?: string): JobDetails['compensation'] {
  const ranges = structuredRanges(structured);
  const relevant = passages.filter(p => p.section !== 'responsibilities'
    && !/\b(?:revenue|raised|funding|budget|valuation)\b/i.test(p.text));
  const candidates = [...relevant];
  if (advertised) candidates.push(structuredEvidence(advertised, advertised));
  for (const evidence of candidates) {
    const regex = /(USD|CAD|GBP|EUR|US\$|C\$|\$|£|€)\s*(\d[\d,]*(?:\.\d+)?k?)(?:\s*(?:[-–—]|to)\s*(?:USD|CAD|GBP|EUR|US\$|C\$|\$|£|€)?\s*(\d[\d,]*(?:\.\d+)?k?))?/gi;
    const matches = [...evidence.text.matchAll(regex)];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const tail = evidence.text.slice(match.index + match[0].length, matches[i + 1]?.index);
      const unit = period(tail.slice(0, 45)) ?? (matches.length === 1 ? period(evidence.text) : null);
      if (!unit) continue;
      const min = amount(match[2]!), max = amount(match[3] ?? match[2]!);
      const symbol = match[1]!.toUpperCase();
      const currency = ({ '$': 'USD', 'US$': 'USD', 'C$': 'CAD', '£': 'GBP', '€': 'EUR' } as Record<string, string>)[symbol] ?? symbol;
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) continue;
      const prefix = evidence.text.slice(i ? matches[i - 1]!.index + matches[i - 1]![0].length : 0, match.index);
      ranges.push({ min, max, currency, period: unit, kind: kind(prefix), evidence,
        source: evidence.start < 0 ? 'structured' : 'description' });
    }
  }
  // Retain separate location/education tiers; deduplicate only identical evidence/values.
  const unique = ranges.filter((range, i) => !ranges.slice(0, i).some(prior =>
    prior.min === range.min && prior.max === range.max && prior.currency === range.currency
    && prior.period === range.period && prior.evidence.text === range.evidence.text));
  const unparsedPay = relevant.some(p => (p.section === 'compensation' || /\b(?:salary|pay|compensation|stipend)\b/i.test(p.text))
    && /(?:[$£€]|\b(?:USD|CAD|GBP|EUR)\b)\s*\d/.test(p.text));
  const source = record(structured), data = record(source['data']);
  const hasStructuredPay = (source['provider'] === 'greenhouse' && Array.isArray(data['pay_input_ranges']) && data['pay_input_ranges'].length > 0)
    || (source['provider'] === 'lever' && typeof record(data['salaryRange'])['min'] === 'number')
    || (source['provider'] === 'ashby' && data['shouldDisplayCompensationOnJobPostings'] === true
      && Object.keys(record(data['compensation'])).length > 0);
  return { status: unique.length || advertised || unparsedPay || hasStructuredPay ? 'listed' : acquisition === 'available' ? 'not_listed' : 'unavailable',
    ranges: unique, passages: relevant };
}

export function compensationLabel(compensation: JobDetails['compensation']): string {
  if (compensation.status === 'not_listed') return 'Pay not listed';
  if (compensation.status === 'unavailable') return 'Pay unavailable';
  const candidates = compensation.ranges.filter(r => r.kind === 'base' || r.kind === 'unspecified');
  const unique = [...new Map(candidates.map(r => [JSON.stringify([r.min, r.max, r.currency, r.period]), r])).values()];
  if (unique.length !== 1) return 'See pay details';
  const range = unique[0]!;
  const symbol = ({ USD: '$', CAD: 'C$', GBP: '£', EUR: '€' } as Record<string, string>)[range.currency] ?? `${range.currency} `;
  const number = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const values = range.min === range.max ? number(range.min) : `${number(range.min)}–${number(range.max)}`;
  const unit = ({ hour: 'hr', day: 'day', week: 'week', month: 'month', year: 'year' } as const)[range.period];
  return `${symbol}${values}/${unit}`;
}
