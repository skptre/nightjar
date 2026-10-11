import { compensationLabel } from './pay';
import type { JobDetails, PayRange } from './types';

// A pay label is worth showing only when it resolves to a concrete amount with a
// known period ("$41/hr", "$95,000–110,000/year"). Anything ambiguous shows nothing.
export function concretePay(label: string): string | null {
  const match = label.match(/^(?:C\$|US\$|[$£€]|[A-Z]{3} )\s*([\d,]+(?:\.\d+)?)(K)?(?:[–-]([\d,]+(?:\.\d+)?)(K)?)?\/(hr|day|week|month|year|yr|wk|mo)$/i);
  if (!match) return null;
  const unit = match[5]!.toLowerCase();
  const minimum: Record<string, number> = { hr: 5, day: 20, week: 100, wk: 100, month: 400, mo: 400, year: 1000, yr: 1000 };
  const first = Number(match[1]!.replaceAll(',', '')) * (match[2] ? 1000 : 1);
  const last = match[3] ? Number(match[3].replaceAll(',', '')) * (match[4] ? 1000 : 1) : first;
  // Some source pages label small reimbursements as compensation or omit the
  // thousands marker on annual salary. An implausible amount is not a pay rate.
  return first >= minimum[unit]! && last >= first ? label : null;
}

const SHORT_UNIT: Record<string, string> = { hr: 'hr', year: 'yr', month: 'mo', week: 'wk', day: 'day' };
const LONG_UNIT: Record<string, string> = { hr: 'an hour', year: 'a year', month: 'a month', week: 'a week', day: 'a day' };

/** List-column pay: "$52/hr", "$95K–110K/yr". */
export function payShort(compensation: JobDetails['compensation'] | null): string | null {
  if (!compensation) return null;
  const label = concretePay(compensationLabel(compensation));
  if (!label) return null;
  const [amount, unit = ''] = label.split('/');
  const compact = unit === 'year' || unit === 'month'
    ? amount!.replace(/(\d[\d,]*(?:\.\d+)?)/g, (n) => {
      const value = Number(n.replace(/,/g, ''));
      return value >= 1000 ? `${String(Math.round(value / 100) / 10).replace(/\.0$/, '')}K` : n;
    })
    : amount!;
  return `${compact}/${SHORT_UNIT[unit] ?? unit}`;
}

/** Sheet pay: "$52 an hour". */
export function payLong(compensation: JobDetails['compensation'] | null): string | null {
  if (!compensation) return null;
  const label = concretePay(compensationLabel(compensation));
  if (!label) return null;
  const [amount, unit = ''] = label.split('/');
  return `${amount!} ${LONG_UNIT[unit] ?? `per ${unit}`}`;
}

/** Pay from the two columns the job list selects out of the details cache. */
export function payFromColumns(status: string | null, ranges: string | null): string | null {
  if (status !== 'listed' || !ranges) return null;
  try {
    const parsed = JSON.parse(ranges) as PayRange[];
    return Array.isArray(parsed) ? payShort({ status: 'listed', ranges: parsed, passages: [] }) : null;
  } catch { return null; }
}
