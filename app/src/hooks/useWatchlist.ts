import { useSyncExternalStore } from 'react';
import { saveLocalValue } from '@/lib/storage';
export interface WatchedCompany { slug: string; name: string; since: string }
const key = 'nightjar_watched_companies';
const event = 'nightjar:watchlist';
function subscribe(callback: () => void): () => void {
  window.addEventListener(event, callback); window.addEventListener('storage', callback);
  return () => { window.removeEventListener(event, callback); window.removeEventListener('storage', callback); };
}
export function readWatchlist(): WatchedCompany[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(data) ? data.filter((item): item is WatchedCompany => Boolean(item)
      && typeof item.slug === 'string' && typeof item.name === 'string' && typeof item.since === 'string') : [];
  } catch { return []; }
}
export function toggleWatch(slug: string, name: string): void {
  const current = readWatchlist();
  const next = current.some(c => c.slug === slug) ? current.filter(c => c.slug !== slug)
    : [...current, { slug, name, since: new Date().toISOString() }];
  saveLocalValue(key, JSON.stringify(next)); window.dispatchEvent(new Event(event));
}
export function useWatchlist(): WatchedCompany[] {
  useSyncExternalStore(subscribe, () => localStorage.getItem(key));
  return readWatchlist();
}
