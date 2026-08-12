export const WORK_AUTH_OPTIONS = [
  { value: 'us_citizen', label: 'US Citizen', requiresSponsorship: false },
  { value: 'permanent_resident', label: 'Permanent Resident', requiresSponsorship: false },
  { value: 'f1_opt_cpt', label: 'F-1 (OPT/CPT)', requiresSponsorship: true },
  { value: 'h1b', label: 'H-1B', requiresSponsorship: true },
  { value: 'other', label: 'Other', requiresSponsorship: null },
] as const;

export type WorkAuth = (typeof WORK_AUTH_OPTIONS)[number]['value'];

export const CLASS_YEAR_OPTIONS = [
  { value: 'freshman', label: 'Freshman' },
  { value: 'sophomore', label: 'Sophomore' },
  { value: 'junior', label: 'Junior' },
  { value: 'senior', label: 'Senior' },
  { value: 'masters', label: "Master's Student" },
  { value: 'phd', label: 'PhD Student' },
  { value: 'new_grad', label: 'New Grad' },
] as const;

export type ClassYear = (typeof CLASS_YEAR_OPTIONS)[number]['value'];

export const CATEGORY_OPTIONS = [
  { value: 'swe', label: 'Software Engineering' },
  { value: 'quant', label: 'Quantitative Finance' },
  { value: 'ml', label: 'Machine Learning / AI' },
  { value: 'hardware', label: 'Hardware / Embedded' },
] as const;

export type Category = (typeof CATEGORY_OPTIONS)[number]['value'];

export interface Profile {
  graduation: string;
  grad_window: [string, string];
  current_class_year: string;
  work_auth: string;
  requires_sponsorship: boolean;
  target_categories: string[];
  locations: string[];
  excluded_companies: string[];
  tiers: Record<string, 1 | 2 | 3>;
  contacts: Record<string, string>;
}

export function computeGradWindow(graduation: string): [string, string] {
  const [yearStr, monthStr] = graduation.split('-');
  if (!yearStr || !monthStr) return [graduation, graduation];

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  let startMonth = month - 6;
  let startYear = year;
  if (startMonth < 1) {
    startMonth += 12;
    startYear -= 1;
  }

  let endMonth = month + 1;
  let endYear = year;
  if (endMonth > 12) {
    endMonth -= 12;
    endYear += 1;
  }

  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    `${String(startYear)}-${pad(startMonth)}`,
    `${String(endYear)}-${pad(endMonth)}`,
  ];
}

export function inferRequiresSponsorship(workAuth: string): boolean | null {
  const option = WORK_AUTH_OPTIONS.find((o) => o.value === workAuth);
  if (!option) return null;
  return option.requiresSponsorship;
}
