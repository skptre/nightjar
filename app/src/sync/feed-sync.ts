import type { NightjarDB } from '@/db/database';

export interface FeedPosting {
  id: string;
  company: string;
  company_slug: string;
  title: string;
  location: string;
  locations: string[];
  url: string;
  source: string;
  source_job_id: string;
  ats: string;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  compensation?: string;
  merged_from?: string[];
  source_metadata?: {
    sponsorship?: string;
    terms?: string[];
    degrees?: string[];
    category?: string;
  };
}

export interface FeedData {
  updated_at: string;
  version: number;
  count: number;
  postings: Record<string, FeedPosting>;
}

export interface MetaData {
  updated_at: string;
  sha256: string;
  count: number;
}

export interface SyncResult {
  newPostingIds: string[];
  updatedCount: number;
  closedCount: number;
  totalCount: number;
  skipped: boolean;
}

const META_HASH_KEY = 'nightjar_feed_meta_sha';
const LAST_SYNCED_KEY = 'nightjar_last_synced_at';

function getFeedBaseUrl(): string {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FEED_URL) {
    return import.meta.env.VITE_FEED_URL as string;
  }
  return '/data';
}

export async function fetchMeta(baseUrl?: string): Promise<MetaData | null> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/meta.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isMetaData(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function fetchFeed(baseUrl?: string): Promise<FeedData | null> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/feed.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isFeedData(data)) return null;
    return data;
  } catch {
    return null;
  }
}

function isMetaData(value: unknown): value is MetaData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['sha256'] === 'string' &&
    typeof obj['count'] === 'number' &&
    typeof obj['updated_at'] === 'string'
  );
}

function isFeedData(value: unknown): value is FeedData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['updated_at'] === 'string' &&
    typeof obj['version'] === 'number' &&
    typeof obj['count'] === 'number' &&
    typeof obj['postings'] === 'object' &&
    obj['postings'] !== null
  );
}

export function getStoredMetaHash(): string | null {
  try {
    return localStorage.getItem(META_HASH_KEY);
  } catch {
    return null;
  }
}

export function setStoredMetaHash(hash: string): void {
  try {
    localStorage.setItem(META_HASH_KEY, hash);
  } catch {
    // localStorage unavailable
  }
}

export function getLastSyncedAt(): string | null {
  try {
    return localStorage.getItem(LAST_SYNCED_KEY);
  } catch {
    return null;
  }
}

export function setLastSyncedAt(iso: string): void {
  try {
    localStorage.setItem(LAST_SYNCED_KEY, iso);
  } catch {
    // localStorage unavailable
  }
}

export async function syncFeed(
  db: NightjarDB,
  baseUrl?: string,
): Promise<SyncResult> {
  const meta = await fetchMeta(baseUrl);
  if (!meta) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  const storedHash = getStoredMetaHash();
  if (storedHash === meta.sha256) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  const feed = await fetchFeed(baseUrl);
  if (!feed) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  const result = upsertPostings(db, feed);

  setStoredMetaHash(meta.sha256);
  setLastSyncedAt(new Date().toISOString());

  return result;
}

export function upsertPostings(db: NightjarDB, feed: FeedData): SyncResult {
  const existingIds = new Set(
    db.query<{ id: string }>('SELECT id FROM postings_cache').map((r) => r.id),
  );

  const now = new Date().toISOString();
  const newPostingIds: string[] = [];
  let updatedCount = 0;
  let closedCount = 0;

  const feedPostingIds = new Set<string>();

  db.transaction(() => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      feedPostingIds.add(id);
      const postingJson = JSON.stringify(posting);

      if (!existingIds.has(id)) {
        db.run(
          `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?)`,
          [id, postingJson, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        newPostingIds.push(id);
      } else {
        db.run(
          `UPDATE postings_cache
           SET data = ?, synced_at = ?, closed_at = COALESCE(?, closed_at), first_seen_at = MIN(first_seen_at, ?)
           WHERE id = ?`,
          [postingJson, now, posting.closed_at ?? null, posting.first_seen_at, id],
        );
        updatedCount++;

        if (posting.closed_at) {
          closedCount++;
        }
      }
    }

    for (const existingId of existingIds) {
      if (!feedPostingIds.has(existingId)) {
        db.run(
          'UPDATE postings_cache SET closed_at = COALESCE(closed_at, ?) WHERE id = ?',
          [now, existingId],
        );
      }
    }
  });

  return {
    newPostingIds,
    updatedCount,
    closedCount,
    totalCount: feedPostingIds.size,
    skipped: false,
  };
}
