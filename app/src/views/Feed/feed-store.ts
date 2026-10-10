// In-memory view cache for the Jobs feed, living ABOVE React Router so it
// survives view unmount/remount during navigation. SQLite remains the durable
// source of truth; this store is a projection cache of already-loaded rows plus
// the ephemeral UI state (filters, sort, selection, scroll) a user expects to
// find unchanged when they return to Jobs.
//
// Lifetime = one app session. A workspace restore or reset triggers
// window.location.reload() (SettingsView / BackupSection), which tears down the
// JS context and re-initialises this singleton empty — so the cache can never
// outlive the data it mirrors. resetFeedStore() exists for the same reason in
// tests, where a single JS context renders the feed many times.

import type { Profile } from '@/profile/types';
import type { PostingRowData } from './PostingRow';

export interface FeedState {
  // Loaded, parsed rows (parsed once at load, not per keystroke).
  rawRows: PostingRowData[];
  // Newly-arrived rows held behind a "Show" affordance so the list does not
  // reorder under the user's cursor mid-scroll.
  pendingRows: PostingRowData[] | null;
  loaded: boolean;
  // Persisted UI state.
  viewMode: 'for-you' | 'all';
  selectedCategories: Set<string>;
  selectedDomains: Set<string>;
  search: string;
  companyFilter: string | null;
  // The sheet's posting (null when closed) and the row expanded inline in the list.
  detailId: string | null;
  openId: string | null;
  selectedIndex: number;
  scrollTop: number;
  // Load bookkeeping: the last signature we loaded for (feed version + relevant
  // profile fields + local-mutation counter). A remount with the same signature
  // is served from cache instead of re-querying.
  loadedSignature: string | null;
  reloadKey: number;
}

function initialState(): FeedState {
  return {
    rawRows: [],
    pendingRows: null,
    loaded: false,
    viewMode: 'all',
    selectedCategories: new Set(),
    selectedDomains: new Set(),
    search: '',
    companyFilter: null,
    detailId: null,
    openId: null,
    selectedIndex: 0,
    scrollTop: 0,
    loadedSignature: null,
    reloadKey: 0,
  };
}

let state: FeedState = initialState();
const listeners = new Set<() => void>();
// Monotonic token guarding against stale async loads overwriting newer results.
let epoch = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function feedSubscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function feedSnapshot(): FeedState {
  return state;
}

/** Patch state and notify subscribers (triggers a re-render of the feed). */
export function setFeed(patch: Partial<FeedState>): void {
  state = { ...state, ...patch };
  emit();
}

/**
 * Record the scroll offset WITHOUT notifying — scroll fires many times a second
 * and nothing needs to react to it except a one-time restore on remount, so a
 * re-render per frame would be pure waste.
 */
export function setScrollTopSilent(value: number): void {
  state.scrollTop = value;
}

/** Reserve the next load epoch; the caller keeps it to detect being superseded. */
export function nextLoadEpoch(): number {
  epoch += 1;
  return epoch;
}

export function currentLoadEpoch(): number {
  return epoch;
}

/** Clear the cache. The app relies on location.reload() for this; tests call it. */
export function resetFeedStore(): void {
  state = initialState();
  epoch += 1;
  emit();
}

/**
 * The subset of profile fields that affect a posting's stored score/eligibility
 * columns. When these change the feed must reload to pick up recomputed values;
 * cosmetic profile fields (notifications, sync interval) must not force a reload.
 */
export function profileSignature(profile: Profile | null): string {
  if (!profile) return 'guest';
  return JSON.stringify([
    profile.graduation,
    profile.grad_window,
    profile.work_auth,
    profile.requires_sponsorship,
    profile.authorization_path ?? null,
    profile.target_categories,
    profile.excluded_companies,
    profile.tiers,
    profile.scoring_adjustments ?? null,
  ]);
}
