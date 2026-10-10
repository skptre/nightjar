import { useSyncExternalStore } from 'react';

// The header search box is shared by every screen. Jobs keeps its query in the
// feed store; the tracker keeps its own here so the two never overwrite each other.
let trackerQuery = '';
const listeners = new Set<() => void>();

export function setTrackerQuery(value: string): void {
  trackerQuery = value;
  listeners.forEach((listener) => listener());
}

export function useTrackerQuery(): string {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => trackerQuery);
}

export const SEARCH_INPUT_ID = 'nj-search';

export function focusHeaderSearch(): void {
  const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
  input?.focus();
  input?.select();
}
