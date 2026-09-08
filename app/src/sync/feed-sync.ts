import type { Database } from '@/db/database';
import { isTauri } from '@/lib/platform';
import { DescriptionPackCache, hydrateDescriptions, type DescriptionReference } from './description-packs';

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
  description_text?: string;
  description_ref?: DescriptionReference;
  description_status?: string;
  description_version?: number;
  department?: string | null;
  compensation?: string;
  merged_from?: string[];
  source_metadata?: {
    sponsorship?: string;
    terms?: string[];
    degrees?: string[];
    category?: string;
    department?: string;
    occupational_category?: string;
    source_compensation?: unknown;
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
const CACHE_INTEGRITY_KEY = 'nightjar_cache_integrity';
const CACHE_INTEGRITY_VERSION = 'tauri-atomic-batch-v1';
const PRODUCTION_FEED_BASE_URL = 'https://raw.githubusercontent.com/skptre/nightjar/main/data';
const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [250, 750] as const;

export function getFeedBaseUrl(isDevelopment: boolean = import.meta.env.DEV): string {
  let override: string | null = null;
  try {
    override = localStorage.getItem('nightjar_feed_url_override');
  } catch {
    // localStorage unavailable; fall through to the configured/default URL.
  }
  if (override) return override;
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FEED_URL) {
    return import.meta.env.VITE_FEED_URL as string;
  }
  return isDevelopment ? '/data' : PRODUCTION_FEED_BASE_URL;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function waitBeforeRetry(delayMs: number): Promise<void> {
  if (import.meta.env.MODE === 'test') return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = new Error('Feed request failed');

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (attempt < RETRY_DELAYS_MS.length && shouldRetryStatus(response.status)) {
        await waitBeforeRetry(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= RETRY_DELAYS_MS.length) throw error;
      await waitBeforeRetry(RETRY_DELAYS_MS[attempt]!);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError;
}

export async function fetchMeta(baseUrl?: string): Promise<MetaData> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/meta.json`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`Metadata fetch failed (HTTP ${String(response.status)})`);
  }
  const data: unknown = await response.json();
  if (!isMetaData(data)) {
    throw new Error('Metadata response is not valid');
  }
  return data;
}

export async function fetchFeed(baseUrl?: string, forceRefresh = false): Promise<FeedData | null> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/feed.json`;
  try {
    const headers: Record<string, string> = {};
    const lastModified = forceRefresh ? null : getStoredLastModified();
    if (lastModified) {
      headers['If-Modified-Since'] = lastModified;
    }

    const response = await fetchWithRetry(url, { headers });
    if (response.status === 304) return null;
    if (response.status === 404) {
      throw new Error('Feed unavailable (404). Check feed URL in settings.');
    }
    if (!response.ok) {
      throw new Error(`Feed fetch failed (HTTP ${String(response.status)})`);
    }

    const responseLastModified = response.headers.get('Last-Modified');
    if (responseLastModified) {
      setStoredLastModified(responseLastModified);
    }

    const data: unknown = await response.json();
    if (!isFeedData(data)) {
      throw new Error('Feed response is not valid feed data');
    }
    return data;
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new Error('Network error fetching feed');
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
    const response = await fetchWithRetry(url);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isShardIndex(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function computeSha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ShardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShardValidationError';
  }
}

export async function fetchShard(
  shardId: string,
  expectedInfo: ShardInfo,
  baseUrl?: string,
  documentCache?: DescriptionPackCache,
): Promise<ShardData> {
  const base = baseUrl ?? getFeedBaseUrl();
  const url = `${base}/feed/${shardId}.json`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`Shard fetch failed: ${shardId} (HTTP ${String(response.status)})`);
  }

  const rawText = await response.text();

  const hash = await computeSha256(rawText);
  if (hash !== expectedInfo.sha256) {
    throw new ShardValidationError(
      `Shard ${shardId} SHA-256 mismatch: expected ${expectedInfo.sha256}, got ${hash}`,
    );
  }

  const data: unknown = JSON.parse(rawText);
  if (!isShardData(data)) {
    throw new ShardValidationError(`Shard ${shardId} response is not valid shard data`);
  }

  if (data.shard_id !== shardId) {
    throw new ShardValidationError(
      `Shard ID mismatch: requested ${shardId}, received ${data.shard_id}`,
    );
  }

  const actualCount = Object.keys(data.postings).length;
  if (data.count !== actualCount) {
    throw new ShardValidationError(
      `Shard ${shardId} internal count mismatch: header says ${String(data.count)}, actual postings: ${String(actualCount)}`,
    );
  }
  if (actualCount !== expectedInfo.count) {
    throw new ShardValidationError(
      `Shard ${shardId} count mismatch with meta: meta says ${String(expectedInfo.count)}, actual: ${String(actualCount)}`,
    );
  }

  const cache = documentCache ?? createDocumentCache(base);
  return { ...data, postings: await hydrateDescriptions(data.postings, cache) };
}

function createDocumentCache(base: string): DescriptionPackCache {
  return new DescriptionPackCache(async relative => {
    const response = await fetchWithRetry(`${base}/feed/${relative}`);
    if (!response.ok) throw new Error(`Description pack unavailable (HTTP ${String(response.status)})`);
    return response.text();
  });
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

function getCacheIntegrityVersion(): string | null {
  try {
    return localStorage.getItem(CACHE_INTEGRITY_KEY);
  } catch {
    return null;
  }
}

function setCacheIntegrityVersion(): void {
  if (!isTauri()) return;
  try {
    localStorage.setItem(CACHE_INTEGRITY_KEY, CACHE_INTEGRITY_VERSION);
  } catch {
    // localStorage unavailable; the next desktop sync safely repeats the repair.
  }
}

export async function syncFeed(
  db: Database,
  baseUrl?: string,
): Promise<SyncResult> {
  let meta: MetaData;
  try {
    meta = await fetchMeta(baseUrl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch feed metadata';
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false, error: message };
  }

  const storedHash = getStoredMetaHash();
  const localCount = await db.queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM postings_cache',
  );
  const needsIntegrityRepair = isTauri() && getCacheIntegrityVersion() !== CACHE_INTEGRITY_VERSION;
  const forceFullSync = needsIntegrityRepair || (localCount?.count ?? 0) < meta.count;
  if (storedHash === meta.sha256 && !forceFullSync) {
    setLastSyncedAt(new Date().toISOString());
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  if (meta.sharded && meta.shards) {
    const result = await syncFeedSharded(db, meta, baseUrl, forceFullSync);
    if (!result.error && !result.skipped) setCacheIntegrityVersion();
    return result;
  }

  let feed: FeedData | null;
  try {
    feed = await fetchFeed(baseUrl, forceFullSync);
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
  setCacheIntegrityVersion();

  return result;
}

async function syncFeedSharded(
  db: Database,
  meta: MetaData,
  baseUrl?: string,
  forceFullSync = false,
): Promise<SyncResult> {
  const shards = meta.shards!;
  const storedShardHashes = forceFullSync ? {} : getStoredShardHashes();

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

  const documentCache = createDocumentCache(baseUrl ?? getFeedBaseUrl());
  const localDocuments = await db.query<{ description: string | null }>(
    'SELECT description FROM postings_cache WHERE description IS NOT NULL');
  await Promise.all(localDocuments.map(row => documentCache.remember(row.description ?? '')));
  const shardResults = await Promise.allSettled(
    changedShardIds.map((id) => fetchShard(id, shards[id]!, baseUrl, documentCache)),
  );

  const failedShards: string[] = [];
  const mergedPostings: Record<string, FeedPosting> = {};
  const newShardHashes: Record<string, string> = {};

  for (let i = 0; i < changedShardIds.length; i++) {
    const result = shardResults[i]!;
    const shardId = changedShardIds[i]!;
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failedShards.push(`${shardId}: ${reason}`);
      continue;
    }
    for (const [pid, posting] of Object.entries(result.value.postings)) {
      mergedPostings[pid] = posting;
    }
    newShardHashes[shardId] = shards[shardId]!.sha256;
  }

  if (failedShards.length > 0) {
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false, error: `Shard sync failed: ${failedShards.join('; ')}` };
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

  await db.transaction(async (transaction) => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      const postingJson = JSON.stringify(posting);

      if (!existingById.has(id)) {
        await transaction.run(
          `INSERT INTO postings_cache (id, data, description, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, postingJson, posting.description_text ?? null, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        newPostingIds.push(id);
      } else {
        await transaction.run(
          `UPDATE postings_cache
           SET data = ?,
               description = COALESCE(?, description),
               eligibility = CASE
                 WHEN ? IS NOT NULL AND COALESCE(description, '') != ? THEN NULL
                 ELSE eligibility
               END,
               score = CASE
                 WHEN ? IS NOT NULL AND COALESCE(description, '') != ? THEN NULL
                 ELSE score
               END,
               description_error = CASE WHEN ? IS NOT NULL THEN NULL ELSE description_error END,
               synced_at = ?, closed_at = ?, first_seen_at = MIN(first_seen_at, ?)
           WHERE id = ?`,
          [
            postingJson,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            now,
            posting.closed_at ?? null,
            posting.first_seen_at,
            id,
          ],
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
          await transaction.run(
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
        await transaction.run(
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

  await db.transaction(async (transaction) => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      feedPostingIds.add(id);
      const postingJson = JSON.stringify(posting);

      if (!existingIds.has(id)) {
        await transaction.run(
          `INSERT INTO postings_cache (id, data, description, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, postingJson, posting.description_text ?? null, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        newPostingIds.push(id);
      } else {
        await transaction.run(
          `UPDATE postings_cache
           SET data = ?,
               description = COALESCE(?, description),
               eligibility = CASE
                 WHEN ? IS NOT NULL AND COALESCE(description, '') != ? THEN NULL
                 ELSE eligibility
               END,
               score = CASE
                 WHEN ? IS NOT NULL AND COALESCE(description, '') != ? THEN NULL
                 ELSE score
               END,
               description_error = CASE WHEN ? IS NOT NULL THEN NULL ELSE description_error END,
               synced_at = ?, closed_at = ?, first_seen_at = MIN(first_seen_at, ?)
           WHERE id = ?`,
          [
            postingJson,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            posting.description_text ?? null,
            now,
            posting.closed_at ?? null,
            posting.first_seen_at,
            id,
          ],
        );
        updatedCount++;

        if (posting.closed_at) {
          closedCount++;
        }
      }
    }

    for (const existingId of existingIds) {
      // Locally entered tracker records are not governed by the public feed.
      if (existingId.startsWith('local-')) continue;
      if (!feedPostingIds.has(existingId)) {
        await transaction.run(
          'UPDATE postings_cache SET closed_at = COALESCE(closed_at, ?) WHERE id = ?',
          [now, existingId],
        );
      }
    }

    if (feed.companies) {
      for (const [slug, meta] of Object.entries(feed.companies)) {
        await transaction.run(
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
