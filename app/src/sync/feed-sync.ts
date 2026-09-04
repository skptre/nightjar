import type { Database } from '@/db/database';

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

export interface FeedCompanyMeta {
  name: string;
  typical_open: string | null;
}

export interface FeedData {
  updated_at: string;
  version: number;
  count: number;
  postings: Record<string, FeedPosting>;
  companies?: Record<string, FeedCompanyMeta>;
}

export interface ShardInfo {
  sha256: string;
  count: number;
  updated_at: string;
}

export interface MetaData {
  updated_at: string;
  sha256: string;
  count: number;
  sharded?: boolean;
  shards?: Record<string, ShardInfo>;
}

export interface SyncResult {
  newPostingIds: string[];
  updatedCount: number;
  closedCount: number;
  totalCount: number;
  skipped: boolean;
  error?: string;
}

const META_HASH_KEY = 'nightjar_feed_meta_sha';
const LAST_SYNCED_KEY = 'nightjar_last_synced_at';
const LAST_MODIFIED_KEY = 'nightjar_feed_last_modified';
const SHARD_HASHES_KEY = 'nightjar_shard_hashes';

function getFeedBaseUrl(): string {
  const override = localStorage.getItem('nightjar_feed_url_override');
  if (override) return override;
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
    const headers: Record<string, string> = {};
    const lastModified = getStoredLastModified();
    if (lastModified) {
      headers['If-Modified-Since'] = lastModified;
    }

    const response = await fetch(url, { headers });
    if (response.status === 304) return null;
    if (response.status === 404) {
      throw new Error('Feed unavailable (404). Check feed URL in settings.');
    }
    if (!response.ok) return null;

    const responseLastModified = response.headers.get('Last-Modified');
    if (responseLastModified) {
      setStoredLastModified(responseLastModified);
    }

    const data: unknown = await response.json();
    if (!isFeedData(data)) return null;
    return data;
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      return null;
    }
    throw err;
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

export interface ShardIndexEntry {
  id: string;
  count: number;
  sha256: string;
  updated_at: string;
}

export interface ShardIndex {
  version: number;
  updated_at: string;
  total_count: number;
  shards: ShardIndexEntry[];
  companies?: Record<string, FeedCompanyMeta>;
}

interface ShardData {
  shard_id: string;
  updated_at: string;
  count: number;
  postings: Record<string, FeedPosting>;
}

export async function fetchShardIndex(baseUrl?: string): Promise<ShardIndex | null> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/feed/index.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isShardIndex(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function fetchShard(shardId: string, baseUrl?: string): Promise<ShardData | null> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/feed/${shardId}.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isShardData(data)) return null;
    return data;
  } catch {
    return null;
  }
}

function isShardIndex(value: unknown): value is ShardIndex {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['version'] === 'number' &&
    typeof obj['updated_at'] === 'string' &&
    typeof obj['total_count'] === 'number' &&
    Array.isArray(obj['shards'])
  );
}

function isShardData(value: unknown): value is ShardData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['shard_id'] === 'string' &&
    typeof obj['count'] === 'number' &&
    typeof obj['postings'] === 'object' &&
    obj['postings'] !== null
  );
}

export function getStoredShardHashes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SHARD_HASHES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function setStoredShardHashes(hashes: Record<string, string>): void {
  try {
    localStorage.setItem(SHARD_HASHES_KEY, JSON.stringify(hashes));
  } catch {
    // localStorage unavailable
  }
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

export function getStoredLastModified(): string | null {
  try {
    return localStorage.getItem(LAST_MODIFIED_KEY);
  } catch {
    return null;
  }
}

export function setStoredLastModified(value: string): void {
  try {
    localStorage.setItem(LAST_MODIFIED_KEY, value);
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
  db: Database,
  baseUrl?: string,
): Promise<SyncResult> {
  const meta = await fetchMeta(baseUrl);
  if (!meta) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false, error: 'Failed to fetch feed metadata' };
  }

  const storedHash = getStoredMetaHash();
  if (storedHash === meta.sha256) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  if (meta.sharded && meta.shards) {
    return syncFeedSharded(db, meta, baseUrl);
  }

  let feed: FeedData | null;
  try {
    feed = await fetchFeed(baseUrl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Feed fetch failed';
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false, error: message };
  }
  if (!feed) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  const result = await upsertPostings(db, feed);

  setStoredMetaHash(meta.sha256);
  setLastSyncedAt(new Date().toISOString());

  return result;
}

async function syncFeedSharded(
  db: Database,
  meta: MetaData,
  baseUrl?: string,
): Promise<SyncResult> {
  const shards = meta.shards!;
  const storedShardHashes = getStoredShardHashes();

  const changedShardIds: string[] = [];
  for (const [shardId, info] of Object.entries(shards)) {
    if (storedShardHashes[shardId] !== info.sha256) {
      changedShardIds.push(shardId);
    }
  }

  const removedShardIds = Object.keys(storedShardHashes).filter(
    (id) => !(id in shards),
  );

  if (changedShardIds.length === 0 && removedShardIds.length === 0) {
    setStoredMetaHash(meta.sha256);
    setLastSyncedAt(new Date().toISOString());
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  const shardResults = await Promise.all(
    changedShardIds.map((id) => fetchShard(id, baseUrl)),
  );

  const failedShardIds: string[] = [];
  const mergedPostings: Record<string, FeedPosting> = {};
  const newShardHashes: Record<string, string> = {};

  for (let i = 0; i < changedShardIds.length; i++) {
    const shardData = shardResults[i];
    const shardId = changedShardIds[i]!;
    if (!shardData) {
      failedShardIds.push(shardId);
      continue;
    }
    for (const [pid, posting] of Object.entries(shardData.postings)) {
      mergedPostings[pid] = posting;
    }
    newShardHashes[shardId] = shards[shardId]!.sha256;
  }

  if (failedShardIds.length > 0) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false, error: `Failed to fetch shards: ${failedShardIds.join(', ')}` };
  }

  for (const [shardId, hash] of Object.entries(storedShardHashes)) {
    if (!changedShardIds.includes(shardId) && shardId in shards) {
      newShardHashes[shardId] = hash;
    }
  }

  let index: ShardIndex | null = null;
  try {
    index = await fetchShardIndex(baseUrl);
  } catch {
    // companies metadata is best-effort
  }

  const feed: FeedData = {
    updated_at: meta.updated_at,
    version: 1,
    count: meta.count,
    postings: mergedPostings,
  };
  if (index?.companies) {
    feed.companies = index.companies;
  }

  const result = await upsertShardedPostings(db, feed, changedShardIds, removedShardIds);

  setStoredMetaHash(meta.sha256);
  setStoredShardHashes(newShardHashes);
  setLastSyncedAt(new Date().toISOString());

  return result;
}

async function upsertShardedPostings(
  db: Database,
  feed: FeedData,
  changedShardIds: string[],
  removedShardIds: string[],
): Promise<SyncResult> {
  const existingRows = await db.query<{ id: string; data: string }>(
    'SELECT id, data FROM postings_cache',
  );

  const existingById = new Map<string, string>();
  for (const row of existingRows) {
    existingById.set(row.id, row.data);
  }

  const now = new Date().toISOString();
  const newPostingIds: string[] = [];
  let updatedCount = 0;
  let closedCount = 0;

  const changedSources = new Set(changedShardIds);

  await db.transaction(async () => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      const postingJson = JSON.stringify(posting);

      if (!existingById.has(id)) {
        await db.run(
          `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?)`,
          [id, postingJson, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        newPostingIds.push(id);
      } else {
        await db.run(
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

    const feedPostingIds = new Set(Object.keys(feed.postings));
    for (const [existingId, existingData] of existingById) {
      if (feedPostingIds.has(existingId)) continue;
      try {
        const parsed = JSON.parse(existingData) as FeedPosting;
        if (changedSources.has(parsed.source) || removedShardIds.includes(parsed.source)) {
          await db.run(
            'UPDATE postings_cache SET closed_at = COALESCE(closed_at, ?) WHERE id = ?',
            [now, existingId],
          );
        }
      } catch {
        // unparseable cached data — skip
      }
    }

    if (feed.companies) {
      for (const [slug, companyMeta] of Object.entries(feed.companies)) {
        await db.run(
          `INSERT OR REPLACE INTO companies_meta (slug, name, typical_open) VALUES (?, ?, ?)`,
          [slug, companyMeta.name, companyMeta.typical_open ?? null],
        );
      }
    }
  });

  return {
    newPostingIds,
    updatedCount,
    closedCount,
    totalCount: Object.keys(feed.postings).length,
    skipped: false,
  };
}

export async function upsertPostings(db: Database, feed: FeedData): Promise<SyncResult> {
  const existingRows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
  const existingIds = new Set(existingRows.map((r) => r.id));

  const now = new Date().toISOString();
  const newPostingIds: string[] = [];
  let updatedCount = 0;
  let closedCount = 0;

  const feedPostingIds = new Set<string>();

  await db.transaction(async () => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      feedPostingIds.add(id);
      const postingJson = JSON.stringify(posting);

      if (!existingIds.has(id)) {
        await db.run(
          `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?)`,
          [id, postingJson, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        newPostingIds.push(id);
      } else {
        await db.run(
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
        await db.run(
          'UPDATE postings_cache SET closed_at = COALESCE(closed_at, ?) WHERE id = ?',
          [now, existingId],
        );
      }
    }

    if (feed.companies) {
      for (const [slug, meta] of Object.entries(feed.companies)) {
        await db.run(
          `INSERT OR REPLACE INTO companies_meta (slug, name, typical_open) VALUES (?, ?, ?)`,
          [slug, meta.name, meta.typical_open ?? null],
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
