import type { CategoryValue } from './types';

export const CLASSIFICATION_VERSION = 3;
export const DOMAIN_OPTIONS = [
  { value: 'aerospace', label: 'Aerospace' },
  { value: 'quant', label: 'Quant finance' },
  { value: 'finance', label: 'Finance & banking' },
  { value: 'robotics', label: 'Robotics' },
  { value: 'semiconductors', label: 'Semiconductors' },
  { value: 'healthcare', label: 'Healthcare & life sciences' },
  { value: 'energy', label: 'Energy' },
  { value: 'automotive', label: 'Automotive' },
] as const;
export type DomainValue = typeof DOMAIN_OPTIONS[number]['value'];
export type EvidenceSource = 'title' | 'description' | 'department' | 'occupation' | 'source-category';
export interface RoleEvidence {
  axis: 'role' | 'field';
  value: CategoryValue | DomainValue;
  source: EvidenceSource;
  text: string;
  rule: string;
}

// OR within each dimension, AND across dimensions. No pairwise compatibility guesses.
export function matchesRoleSelection(
  roles: readonly CategoryValue[],
  domains: readonly DomainValue[],
  selectedRoles: ReadonlySet<string>,
  selectedDomains: ReadonlySet<string>,
): boolean {
  return (selectedRoles.size === 0 || roles.some(role => selectedRoles.has(role)))
    && (selectedDomains.size === 0 || domains.some(domain => selectedDomains.has(domain)));
}

export function parseRoleDomains(stored: string | null | undefined): DomainValue[] {
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || !('domain_tags' in value) || !Array.isArray(value.domain_tags)) return [];
    const tags = value.domain_tags;
    return DOMAIN_OPTIONS.map(option => option.value).filter(domain => tags.includes(domain));
  } catch {
    return [];
  }
}
