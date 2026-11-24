import { yieldToUI } from '@/lib/background';
import type { Database, SqlValue } from '@/db/database';
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
  description_pending?: boolean;
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
  path?: string;
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
const CACHE_INTEGRITY_VERSION = 'tauri-chunked-feed-v1';
const CACHED_OPEN_COUNT_KEY = 'nightjar_cached_open_count';
const NATIVE_FEED_BATCH_SIZE = 200;
const PRODUCTION_FEED_BASE_URL = 'https://raw.githubusercontent.com/skptre/nightjar/main/data';
const FETCH_TIMEOUT_MS = 15_000;
export function getFeedFreshness(): {updatedAt: string | null; source: string | null} {
  return {updatedAt:localStorage.getItem('nightjar_feed_published_at'),source:localStorage.getItem('nightjar_feed_source')};
}
function recordFeedFreshness(meta: MetaData, baseUrl?: string): void {
  try {
    localStorage.setItem('nightjar_feed_published_at',meta.updated_at);
    localStorage.setItem('nightjar_feed_source',baseUrl === '/data' && !import.meta.env.DEV ? 'bundled' : import.meta.env.DEV ? 'development' : 'live');
  } catch { /* Metadata failure must not invalidate an imported feed. */ }
}
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

export async function fetchFeed(baseUrl?: string, forceRefresh = false, expectedMeta?: MetaData): Promise<FeedData | null> {
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

    const text = await response.text();
    if (expectedMeta && await computeSha256(text.replace(/\r\n/g, '\n')) !== expectedMeta.sha256) {
      throw new Error('Feed checksum mismatch; retry the update');
    }
    const data: unknown = JSON.parse(text);
    if (!isFeedData(data)) {
      throw new Error('Feed response is not valid feed data');
    }
    if (expectedMeta && (data.count !== expectedMeta.count
        || Object.keys(data.postings).length !== data.count
        || Object.entries(data.postings).some(([id, row]) => row.id !== id))) {
      throw new Error('Feed count or posting identity mismatch');
    }
    const responseLastModified = response.headers.get('Last-Modified');
    if (responseLastModified) setStoredLastModified(responseLastModified);
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
  if (expectedInfo.path && expectedInfo.path !== `snapshots/${expectedInfo.sha256}.json`) {
    throw new ShardValidationError('Invalid immutable shard reference');
  }
  const url = `${base}/feed/${expectedInfo.path ?? `${shardId}.json`}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`Shard fetch failed: ${shardId} (HTTP ${String(response.status)})`);
  }

  const rawText = await response.text();

  // Git on Windows can check published JSON out with CRLF while its manifest
  // records the LF bytes in the repository. Accept only that canonical form;
  // all other content changes still fail the SHA-256 check.
  const hash = await computeSha256(rawText.replace(/\r\n/g, '\n'));
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
  return { ...data, postings: await hydrateDescriptions(data.postings, cache, true) };
}

function createDocumentCache(base: string): DescriptionPackCache {
  return new DescriptionPackCache(async relative => {
    const response = await fetchWithRetry(`${base}/feed/${relative}`, { cache: 'no-cache' });
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

export async function syncFeed(db: Database, baseUrl?: string): Promise<SyncResult> {
  if (!baseUrl && typeof navigator !== 'undefined' && !navigator.onLine) {
    const count = await db.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM postings_cache');
    const result = await useNewerBundledFeed(db, count?.count ?? 0, { newPostingIds: [], updatedCount: 0,
      closedCount: 0, totalCount: count?.count ?? 0, skipped: false, error: 'Offline' });
    return finalizeLocalCache(db, result);
  }
  const result = await syncFeedFromSource(db, baseUrl);
  // The packaged feed can repair an empty or older cache when the remote feed is
  // unavailable. A newer local cache must never be replaced by the bundle.
  if (result.error && !baseUrl && !import.meta.env.DEV) {
    const count = await db.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM postings_cache');
    return finalizeLocalCache(db, await useNewerBundledFeed(db, count?.count ?? 0, result));
  }
  return finalizeLocalCache(db, result);
}

async function finalizeLocalCache(db: Database, result: SyncResult): Promise<SyncResult> {
  // Keep the posting behind a saved application, but discard all other closed
  // postings and their derived details. This also cleans up older installations.
  const obsolete = await db.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM postings_cache
    WHERE closed_at IS NOT NULL AND id NOT IN (SELECT posting_id FROM applications)`);
  if ((obsolete?.count ?? 0) > 0) {
    const unusedClosed = `posting_id IN (
      SELECT id FROM postings_cache WHERE closed_at IS NOT NULL
        AND id NOT IN (SELECT posting_id FROM applications))`;
    await db.batch([
      { sql: `DELETE FROM job_details_cache WHERE ${unusedClosed}` },
      { sql: `DELETE FROM postings_cache WHERE closed_at IS NOT NULL
        AND id NOT IN (SELECT posting_id FROM applications)` },
    ]);
  }
  if (result.error) return result;
  const open = await db.queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM postings_cache WHERE closed_at IS NULL');
  try { localStorage.setItem(CACHED_OPEN_COUNT_KEY, String(open?.count ?? 0)); }
  catch { /* A future sync can safely recheck the local cache. */ }
  return result;
}

async function useNewerBundledFeed(db: Database, cachedCount: number, failure: SyncResult): Promise<SyncResult> {
  let bundledMeta: MetaData;
  try { bundledMeta = await fetchMeta('/data'); } catch { return failure; }

  if (cachedCount > 0) {
    const publishedAt = getFeedFreshness().updatedAt;
    const latestRow = publishedAt ? null : await db.queryOne<{ synced_at: string | null }>(
      'SELECT MAX(synced_at) AS synced_at FROM postings_cache');
    const cachedAt = Date.parse(publishedAt ?? latestRow?.synced_at ?? '');
    const bundledAt = Date.parse(bundledMeta.updated_at);
    const bundleIsNewer = Number.isFinite(cachedAt) && Number.isFinite(bundledAt)
      ? bundledAt > cachedAt : bundledMeta.count > cachedCount;
    if (!bundleIsNewer) return failure;
  }

  const bundled = await syncFeedFromSource(db, '/data');
  return bundled.error ? failure : bundled;
}

async function syncFeedFromSource(
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
    'SELECT COUNT(*) AS count FROM postings_cache WHERE closed_at IS NULL',
  );
  const recordedOpenCountText = localStorage.getItem(CACHED_OPEN_COUNT_KEY);
  const recordedOpenCount = Number(recordedOpenCountText);
  const hasRecordedOpenCount = recordedOpenCountText !== null
    && Number.isSafeInteger(recordedOpenCount) && recordedOpenCount >= 0;
  const needsIntegrityRepair = isTauri() && getCacheIntegrityVersion() !== CACHE_INTEGRITY_VERSION;
  const forceFullSync = needsIntegrityRepair || !hasRecordedOpenCount
    || (localCount?.count ?? 0) < recordedOpenCount;
  if (storedHash === meta.sha256 && !forceFullSync) {
    setLastSyncedAt(new Date().toISOString());
    recordFeedFreshness(meta, baseUrl);
    return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: true };
  }

  if (meta.sharded && meta.shards) {
    const result = await syncFeedSharded(db, meta, baseUrl, forceFullSync);
    if (!result.error) recordFeedFreshness(meta, baseUrl);
    if (!result.error && !result.skipped) setCacheIntegrityVersion();
    return result;
  }

  let feed: FeedData | null;
  try {
    feed = await fetchFeed(baseUrl, true, meta);
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
  recordFeedFreshness(meta, baseUrl);
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
  // Bound bridge payloads and hashing concurrency while refreshing changed shards.
  let afterId = '';
  for (;;) {
    const documents = await db.query<{id: string; description: string}>(
      `SELECT id,description FROM postings_cache WHERE id > ? AND description IS NOT NULL ORDER BY id LIMIT 25`, [afterId]);
    if (!documents.length) break;
    await Promise.all(documents.map(row => documentCache.remember(row.description, row.id)));
    afterId = documents[documents.length - 1]!.id;
    await yieldToUI();
  }
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
    if (!Object.values(result.value.postings).some(posting => posting.description_pending)) {
      newShardHashes[shardId] = shards[shardId]!.sha256;
    }
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

  if (!Object.values(mergedPostings).some(posting => posting.description_pending)) {
    setStoredMetaHash(meta.sha256);
  }
  setStoredShardHashes(newShardHashes);
  setLastSyncedAt(new Date().toISOString());

  return result;
}

type FeedWrite = (sql: string, params?: SqlValue[]) => Promise<void>;

async function applyFeedWrites(db: Database, apply: (write: FeedWrite) => Promise<void>): Promise<void> {
  if (!isTauri()) {
    await db.transaction(async transaction => apply((sql, params) => transaction.run(sql, params)));
    return;
  }

  // Feed imports are idempotent. Commit small native batches so a large public
  // snapshot never has to cross the WebView IPC bridge in one message. The feed
  // manifest is recorded only after every batch succeeds, so an interrupted
  // import is retried in full on the next sync.
  let statements: Parameters<Database['batch']>[0] = [];
  const flush = async (): Promise<void> => {
    if (statements.length === 0) return;
    const pending = statements;
    statements = [];
    await db.batch(pending);
  };
  await apply(async (sql, params) => {
    statements.push(params ? { sql, params } : { sql });
    if (statements.length >= NATIVE_FEED_BATCH_SIZE) await flush();
  });
  await flush();
}

async function upsertShardedPostings(
  db: Database,
  feed: FeedData,
  changedShardIds: string[],
  removedShardIds: string[],
): Promise<SyncResult> {
  const existingRows = await db.query<{ id: string; data: string }>(
    "SELECT id, CASE WHEN json_valid(data) THEN json_object('source',json_extract(data,'$.source')) ELSE '{}' END AS data FROM postings_cache",
  );

  const existingById = new Map<string, string>();
  for (const row of existingRows) {
    existingById.set(row.id, row.data);
  }

  const now = new Date().toISOString();
  const trackedIds = new Set((await db.query<{ posting_id: string }>('SELECT posting_id FROM applications'))
    .map(row => row.posting_id));
  const newPostingIds: string[] = [];
  let updatedCount = 0;
  let closedCount = 0;

  const changedSources = new Set(changedShardIds);

  await applyFeedWrites(db, async write => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      const {description_text: _description, ...metadata} = posting;
      const postingJson = JSON.stringify(metadata);

      if (!existingById.has(id)) {
        if (posting.closed_at && !trackedIds.has(id)) continue;
        await write(
          `INSERT INTO postings_cache (id, data, description, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, postingJson, posting.description_text ?? null, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        if (!posting.closed_at) newPostingIds.push(id);
      } else {
        await write(
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
          await write(
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
        await write(
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
  const trackedIds = new Set((await db.query<{ posting_id: string }>('SELECT posting_id FROM applications'))
    .map(row => row.posting_id));

  const now = new Date().toISOString();
  const newPostingIds: string[] = [];
  let updatedCount = 0;
  let closedCount = 0;

  const feedPostingIds = new Set<string>();

  await applyFeedWrites(db, async write => {
    for (const [id, posting] of Object.entries(feed.postings)) {
      feedPostingIds.add(id);
      const {description_text: _description, ...metadata} = posting;
      const postingJson = JSON.stringify(metadata);

      if (!existingIds.has(id)) {
        if (posting.closed_at && !trackedIds.has(id)) continue;
        await write(
          `INSERT INTO postings_cache (id, data, description, first_seen_at, closed_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, postingJson, posting.description_text ?? null, posting.first_seen_at, posting.closed_at ?? null, now],
        );
        if (!posting.closed_at) newPostingIds.push(id);
      } else {
        await write(
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
        await write(
          'UPDATE postings_cache SET closed_at = COALESCE(closed_at, ?) WHERE id = ?',
          [now, existingId],
        );
      }
    }

    if (feed.companies) {
      for (const [slug, meta] of Object.entries(feed.companies)) {
        await write(
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
