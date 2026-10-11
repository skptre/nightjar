/** Keep the source's city and region together; remove only a redundant US suffix. */
export function formatLocation(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  const parts = cleaned.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length > 1 && /^(?:united states(?: of america)?|usa|us)$/i.test(parts.at(-1)!)) parts.pop();
  return parts.join(', ') || cleaned;
}

export function postingLocations(locations: readonly string[], fallback?: string | null): string[] {
  const source = locations.length ? locations : fallback ? [fallback] : [];
  const unique = new Set<string>();
  const result: string[] = [];
  for (const location of source) {
    const formatted = formatLocation(location);
    if (formatted && !unique.has(formatted.toLocaleLowerCase())) {
      unique.add(formatted.toLocaleLowerCase());
      result.push(formatted);
    }
  }
  return result;
}

export function locationSummary(locations: readonly string[], fallback?: string | null): string {
  const all = postingLocations(locations, fallback);
  if (all.length === 0) return 'Not listed';
  return all.length === 1 ? all[0]! : `${all[0]!} +${String(all.length - 1)}`;
}
