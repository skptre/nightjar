import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import {
  syncFeed,
  upsertPostings,
  fetchMeta,
  fetchFeed,
  getFeedBaseUrl,
  computeSha256,
  ShardValidationError,
  getStoredMetaHash,
  getLastSyncedAt,
  setStoredMetaHash,
  getStoredLastModified,
  setStoredLastModified,
  getStoredShardHashes,
  setStoredShardHashes,
  type FeedData,
  type FeedPosting,
  type MetaData,
  type ShardInfo,
} from './feed-sync';
import { fireNewPostingNotifications, getNewPostingSummaries } from './notifications';

function makePosting(overrides: Partial<FeedPosting> & { id: string }): FeedPosting {
  return {
    company: 'TestCo',
    company_slug: 'testco',
    title: 'SWE Intern',
    location: 'NYC',
    locations: ['NYC'],
    url: 'https://example.com/jobs/1',
    source: 'greenhouse',
    source_job_id: '12345',
    ats: 'greenhouse',
    posted_at: '2026-08-01T00:00:00Z',
    first_seen_at: '2026-08-01T00:00:00Z',
    last_seen_at: '2026-08-12T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

function makeFeed(postings: Record<string, FeedPosting>): FeedData {
  return {
    updated_at: '2026-08-12T00:00:00Z',
    version: 1,
    count: Object.keys(postings).length,
    postings,
  };
}

function makeMeta(sha256: string, count: number): MetaData {
  return {
    updated_at: '2026-08-12T00:00:00Z',
    sha256,
    count,
  };
}

function mockFetchResponses(responses: Record<string, { ok: boolean; body?: unknown; rawText?: string; status?: number }>): void {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        if (!response.ok) {
          const status = response.status ?? 404;
          return Promise.resolve({
            ok: false,
            status,
            json: () => Promise.reject(new Error('Not found')),
            text: () => Promise.resolve(''),
          });
        }
        const textContent = response.rawText ?? JSON.stringify(response.body);
        return Promise.resolve({
          ok: true,
          status: response.status ?? 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(response.body ?? JSON.parse(textContent)),
          text: () => Promise.resolve(textContent),
        });
      }
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
  }));
}

describe('feed-sync', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
    localStorage.clear();
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  describe('fetchMeta', () => {
    it('uses the public GitHub feed outside development', () => {
      expect(getFeedBaseUrl(false)).toBe(
        'https://raw.githubusercontent.com/skptre/nightjar/main/data',
      );
    });

    it('uses the local Vite data route during development', () => {
      expect(getFeedBaseUrl(true)).toBe('/data');
    });

    it('returns parsed meta data on success', async () => {
      const meta = makeMeta('abc123hash', 42);
      mockFetchResponses({ 'meta.json': { ok: true, body: meta } });

      const result = await fetchMeta('/test');
      expect(result).toEqual(meta);
    });

    it('throws on HTTP error', async () => {
      mockFetchResponses({ 'meta.json': { ok: false, body: null, status: 500 } });

      await expect(fetchMeta('/test')).rejects.toThrow(/HTTP 500/);
    });

    it('throws on network error', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Network error'))));

      await expect(fetchMeta('/test')).rejects.toThrow('Network error');
    });

    it('retries a transient metadata failure', async () => {
      const meta = makeMeta('retry-success', 12);
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(meta),
        }));

      await expect(fetchMeta('/test')).resolves.toEqual(meta);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('throws on malformed response', async () => {
      mockFetchResponses({ 'meta.json': { ok: true, body: { foo: 'bar' } } });

      await expect(fetchMeta('/test')).rejects.toThrow(/not valid/);
    });
  });

  describe('fetchFeed', () => {
    it('returns parsed feed data on success', async () => {
      const feed = makeFeed({ p1: makePosting({ id: 'p1' }) });
      mockFetchResponses({ 'feed.json': { ok: true, body: feed } });

      const result = await fetchFeed('/test');
      expect(result).toEqual(feed);
      expect(result!.postings['p1']!.title).toBe('SWE Intern');
    });

    it('throws on 404 with helpful message', async () => {
      mockFetchResponses({ 'feed.json': { ok: false, body: null } });

      await expect(fetchFeed('/test')).rejects.toThrow(/404/);
    });

    it('throws on malformed response', async () => {
      mockFetchResponses({ 'feed.json': { ok: true, body: [] } });

      await expect(fetchFeed('/test')).rejects.toThrow(/not valid/);
    });

    it('sends If-Modified-Since header when stored Last-Modified exists', async () => {
      setStoredLastModified('Wed, 26 Aug 2026 03:33:48 GMT');
      const feed = makeFeed({ p1: makePosting({ id: 'p1' }) });

      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['If-Modified-Since']).toBe('Wed, 26 Aug 2026 03:33:48 GMT');
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'Last-Modified': 'Thu, 27 Aug 2026 10:00:00 GMT' }),
          json: () => Promise.resolve(feed),
        });
      }));

      const result = await fetchFeed('/test');
      expect(result).toEqual(feed);
      expect(getStoredLastModified()).toBe('Thu, 27 Aug 2026 10:00:00 GMT');
    });

    it('does not send If-Modified-Since when no stored value', async () => {
      const feed = makeFeed({ p1: makePosting({ id: 'p1' }) });

      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['If-Modified-Since']).toBeUndefined();
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({}),
          json: () => Promise.resolve(feed),
        });
      }));

      await fetchFeed('/test');
    });

    it('returns null on 304 Not Modified', async () => {
      setStoredLastModified('Wed, 26 Aug 2026 03:33:48 GMT');

      vi.stubGlobal('fetch', vi.fn(() => {
        return Promise.resolve({
          ok: false,
          status: 304,
          headers: new Headers({}),
          json: () => Promise.reject(new Error('No body on 304')),
        });
      }));

      const result = await fetchFeed('/test');
      expect(result).toBeNull();
    });

    it('stores Last-Modified from response header', async () => {
      const feed = makeFeed({ p1: makePosting({ id: 'p1' }) });

      vi.stubGlobal('fetch', vi.fn(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'Last-Modified': 'Fri, 28 Aug 2026 12:00:00 GMT' }),
          json: () => Promise.resolve(feed),
        });
      }));

      await fetchFeed('/test');
      expect(getStoredLastModified()).toBe('Fri, 28 Aug 2026 12:00:00 GMT');
    });
  });

  describe('upsertPostings', () => {
    it('inserts new postings and flags them', async () => {
      const feed = makeFeed({
        p1: makePosting({ id: 'p1', title: 'Role A' }),
        p2: makePosting({ id: 'p2', title: 'Role B' }),
      });

      const result = await upsertPostings(db, feed);

      expect(result.newPostingIds).toEqual(['p1', 'p2']);
      expect(result.updatedCount).toBe(0);
      expect(result.totalCount).toBe(2);

      const rows = await db.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache ORDER BY id',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe('p1');

      const parsed = JSON.parse(rows[0]!.data) as FeedPosting;
      expect(parsed.title).toBe('Role A');
    });

    it('updates existing postings without flagging as new', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', '{"title":"Old Title"}', '2026-08-01T00:00:00Z', now],
      );

      const feed = makeFeed({
        p1: makePosting({ id: 'p1', title: 'New Title' }),
      });

      const result = await upsertPostings(db, feed);

      expect(result.newPostingIds).toEqual([]);
      expect(result.updatedCount).toBe(1);

      const row = await db.queryOne<{ data: string }>(
        'SELECT data FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      const parsed = JSON.parse(row!.data) as FeedPosting;
      expect(parsed.title).toBe('New Title');
    });

    it('preserves computed fields on update', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, category, term, eligibility, score, score_breakdown, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['p1', '{}', '2026-08-01T00:00:00Z', now, 'swe', 'summer_2027', '{"verdict":"eligible"}', 85.5, '{"tier":30}', 'Full description here'],
      );

      const feed = makeFeed({
        p1: makePosting({ id: 'p1' }),
      });
      await upsertPostings(db, feed);

      const row = await db.queryOne<{
        category: string | null;
        term: string | null;
        eligibility: string | null;
        score: number | null;
        score_breakdown: string | null;
        description: string | null;
      }>(
        'SELECT category, term, eligibility, score, score_breakdown, description FROM postings_cache WHERE id = ?',
        ['p1'],
      );

      expect(row!.category).toBe('swe');
      expect(row!.term).toBe('summer_2027');
      expect(row!.eligibility).toBe('{"verdict":"eligible"}');
      expect(row!.score).toBe(85.5);
      expect(row!.score_breakdown).toBe('{"tier":30}');
      expect(row!.description).toBe('Full description here');
    });

    it('stores feed descriptions and invalidates stale profile results', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        `INSERT INTO postings_cache (id, data, description, first_seen_at, synced_at, eligibility, score)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['p1', '{}', 'Old description', '2026-08-01T00:00:00Z', now, '{"verdict":"unclear"}', 50],
      );

      await upsertPostings(db, makeFeed({
        p1: makePosting({ id: 'p1', description_text: 'New description' }),
      }));

      const row = await db.queryOne<{ description: string; eligibility: string | null; score: number | null }>(
        'SELECT description, eligibility, score FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row).toEqual({ description: 'New description', eligibility: null, score: null });
    });

    it('updates closed_at when feed has it set', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', '{}', '2026-08-01T00:00:00Z', now],
      );

      const row1 = await db.queryOne<{ closed_at: string | null }>(
        'SELECT closed_at FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row1!.closed_at).toBeNull();

      const feed = makeFeed({
        p1: makePosting({ id: 'p1', closed_at: '2026-08-11T00:00:00Z' }),
      });
      const result = await upsertPostings(db, feed);

      expect(result.closedCount).toBe(1);

      const row2 = await db.queryOne<{ closed_at: string | null }>(
        'SELECT closed_at FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row2!.closed_at).toBe('2026-08-11T00:00:00Z');
    });

    it('reopens a cached posting when the authoritative feed says it is open', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at) VALUES (?, ?, ?, ?, ?)',
        ['p1', '{}', '2026-08-01T00:00:00Z', '2026-08-10T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      const feed = makeFeed({
        p1: makePosting({ id: 'p1', closed_at: null }),
      });
      await upsertPostings(db, feed);

      const row = await db.queryOne<{ closed_at: string | null }>(
        'SELECT closed_at FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row!.closed_at).toBeNull();
    });

    it('sets closed_at on postings missing from feed', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['orphan1', '{}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      const feed = makeFeed({
        p1: makePosting({ id: 'p1' }),
      });
      await upsertPostings(db, feed);

      const row = await db.queryOne<{ closed_at: string | null }>(
        'SELECT closed_at FROM postings_cache WHERE id = ?',
        ['orphan1'],
      );
      expect(row!.closed_at).not.toBeNull();
    });

    it('does not double-set closed_at on already-closed orphans', async () => {
      const originalClosed = '2026-08-05T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at) VALUES (?, ?, ?, ?, ?)',
        ['orphan1', '{}', '2026-08-01T00:00:00Z', originalClosed, '2026-08-12T00:00:00Z'],
      );

      const feed = makeFeed({
        p1: makePosting({ id: 'p1' }),
      });
      await upsertPostings(db, feed);

      const row = await db.queryOne<{ closed_at: string | null }>(
        'SELECT closed_at FROM postings_cache WHERE id = ?',
        ['orphan1'],
      );
      expect(row!.closed_at).toBe(originalClosed);
    });

    it('preserves earliest first_seen_at on update', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', '{}', '2026-07-01T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      const feed = makeFeed({
        p1: makePosting({ id: 'p1', first_seen_at: '2026-08-01T00:00:00Z' }),
      });
      await upsertPostings(db, feed);

      const row = await db.queryOne<{ first_seen_at: string | null }>(
        'SELECT first_seen_at FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row!.first_seen_at).toBe('2026-07-01T00:00:00Z');
    });

    it('handles mixed new and existing postings', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['existing', '{}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      const feed = makeFeed({
        existing: makePosting({ id: 'existing' }),
        brand_new: makePosting({ id: 'brand_new', title: 'Brand New Role' }),
      });

      const result = await upsertPostings(db, feed);

      expect(result.newPostingIds).toEqual(['brand_new']);
      expect(result.updatedCount).toBe(1);
      expect(result.totalCount).toBe(2);
    });

    it('handles empty feed gracefully', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', '{}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      const feed = makeFeed({});
      const result = await upsertPostings(db, feed);

      expect(result.newPostingIds).toEqual([]);
      expect(result.totalCount).toBe(0);

      const row = await db.queryOne<{ closed_at: string | null }>(
        'SELECT closed_at FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row!.closed_at).not.toBeNull();
    });
  });

  describe('syncFeed', () => {
    it('fetches meta then feed when hash differs', async () => {
      const meta = makeMeta('newhash123', 2);
      const feed = makeFeed({
        p1: makePosting({ id: 'p1' }),
        p2: makePosting({ id: 'p2' }),
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'feed.json': { ok: true, body: feed },
      });

      const result = await syncFeed(db, '/test');

      expect(result.skipped).toBe(false);
      expect(result.newPostingIds).toHaveLength(2);
      expect(result.totalCount).toBe(2);

      expect(getStoredMetaHash()).toBe('newhash123');
    });

    it('skips feed fetch when hash matches', async () => {
      setStoredMetaHash('samehash');
      const meta = makeMeta('samehash', 5);

      for (let i = 0; i < 5; i++) {
        await db.run(
          'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
          [`p${String(i)}`, '{}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
        );
      }

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
      });

      const result = await syncFeed(db, '/test');

      expect(result.skipped).toBe(true);
      expect(result.newPostingIds).toEqual([]);
      expect(getLastSyncedAt()).not.toBeNull();

      const fetchFn = vi.mocked(fetch);
      const calls = fetchFn.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('feed.json'))).toBe(false);
    });

    it('returns error on meta fetch failure', async () => {
      mockFetchResponses({
        'meta.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error on feed fetch failure', async () => {
      const meta = makeMeta('newhash', 5);
      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'feed.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('preserves existing SQLite data on network error', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['existing', '{"title":"Keep Me"}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Network error'))));

      const result = await syncFeed(db, '/test');
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();

      const row = await db.queryOne<{ data: string }>(
        'SELECT data FROM postings_cache WHERE id = ?',
        ['existing'],
      );
      expect(row!.data).toBe('{"title":"Keep Me"}');
    });

    it('detects new postings correctly', async () => {
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['old', '{}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
      );

      const meta = makeMeta('changed', 2);
      const feed = makeFeed({
        old: makePosting({ id: 'old' }),
        new1: makePosting({ id: 'new1', title: 'New Position' }),
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'feed.json': { ok: true, body: feed },
      });

      const result = await syncFeed(db, '/test');

      expect(result.newPostingIds).toEqual(['new1']);
      expect(result.updatedCount).toBe(1);
    });
  });

  describe('sharded sync', () => {
    function makeShardText(shardId: string, postings: Record<string, FeedPosting>): string {
      return JSON.stringify({
        shard_id: shardId,
        updated_at: '2026-08-12T00:00:00Z',
        count: Object.keys(postings).length,
        postings,
      }, null, 2) + '\n';
    }

    async function makeShardWithHash(shardId: string, postings: Record<string, FeedPosting>) {
      const text = makeShardText(shardId, postings);
      const sha256 = await computeSha256(text);
      return { text, sha256, count: Object.keys(postings).length };
    }

    function makeShardedMeta(
      feedHash: string,
      totalCount: number,
      shards: Record<string, ShardInfo>,
    ): MetaData {
      return {
        updated_at: '2026-08-12T00:00:00Z',
        sha256: feedHash,
        count: totalCount,
        sharded: true,
        shards,
      };
    }

    it('correctly syncs multiple valid shards', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse', company: 'Acme', company_slug: 'acme' });
      const p2 = makePosting({ id: 'p2', source: 'lever', company: 'Beta', company_slug: 'beta' });

      const gh = await makeShardWithHash('greenhouse', { p1 });
      const lv = await makeShardWithHash('lever', { p2 });

      const meta = makeShardedMeta('feedhash_new', 2, {
        greenhouse: { sha256: gh.sha256, count: gh.count, updated_at: '2026-08-12T00:00:00Z' },
        lever: { sha256: lv.sha256, count: lv.count, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'lever.json': { ok: true, rawText: lv.text },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toBeUndefined();
      expect(result.skipped).toBe(false);
      expect(result.newPostingIds).toHaveLength(2);
      expect(result.newPostingIds).toContain('p1');
      expect(result.newPostingIds).toContain('p2');
      expect(result.totalCount).toBe(2);

      expect(getStoredMetaHash()).toBe('feedhash_new');
      const storedShardHashes = getStoredShardHashes();
      expect(storedShardHashes['greenhouse']).toBe(gh.sha256);
      expect(storedShardHashes['lever']).toBe(lv.sha256);
    });

    it('repairs an incomplete local cache even when remote hashes match', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const p2 = makePosting({ id: 'p2', source: 'lever' });
      const gh = await makeShardWithHash('greenhouse', { p1 });
      const lv = await makeShardWithHash('lever', { p2 });
      const meta = makeShardedMeta('current-feed-hash', 2, {
        greenhouse: { sha256: gh.sha256, count: 1, updated_at: '2026-08-12T00:00:00Z' },
        lever: { sha256: lv.sha256, count: 1, updated_at: '2026-08-12T00:00:00Z' },
      });

      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', JSON.stringify(p1), p1.first_seen_at, '2026-08-12T00:00:00Z'],
      );
      setStoredMetaHash(meta.sha256);
      setStoredShardHashes({ greenhouse: gh.sha256, lever: lv.sha256 });
      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'lever.json': { ok: true, rawText: lv.text },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.skipped).toBe(false);
      expect(result.error).toBeUndefined();
      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache ORDER BY id');
      expect(rows.map((row) => row.id)).toEqual(['p1', 'p2']);
      const fetchCalls = vi.mocked(fetch).mock.calls.map((call) => call[0] as string);
      expect(fetchCalls.some((url) => url.includes('greenhouse.json'))).toBe(true);
      expect(fetchCalls.some((url) => url.includes('lever.json'))).toBe(true);
    });

    it('rejects shard with mismatched shard_id — zero writes', async () => {
      const wrongIdPostings = { p1: makePosting({ id: 'p1', source: 'greenhouse' }) };
      const wrongIdText = makeShardText('lever', wrongIdPostings);
      const wrongIdHash = await computeSha256(wrongIdText);

      const meta = makeShardedMeta('feedhash', 1, {
        greenhouse: { sha256: wrongIdHash, count: 1, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: wrongIdText },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toContain('Shard ID mismatch');
      expect(result.newPostingIds).toHaveLength(0);

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });

    it('rejects shard with internal count mismatch — zero writes', async () => {
      const badCountData = {
        shard_id: 'greenhouse',
        updated_at: '2026-08-12T00:00:00Z',
        count: 5,
        postings: { p1: makePosting({ id: 'p1', source: 'greenhouse' }) },
      };
      const badCountText = JSON.stringify(badCountData, null, 2) + '\n';
      const badCountHash = await computeSha256(badCountText);

      const meta = makeShardedMeta('feedhash', 5, {
        greenhouse: { sha256: badCountHash, count: 5, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: badCountText },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toContain('internal count mismatch');
      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });

    it('rejects shard with meta count mismatch — zero writes', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const gh = await makeShardWithHash('greenhouse', { p1 });

      const meta = makeShardedMeta('feedhash', 10, {
        greenhouse: { sha256: gh.sha256, count: 10, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toContain('count mismatch with meta');
      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });

    it('rejects shard with wrong SHA-256 — zero writes', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const gh = await makeShardWithHash('greenhouse', { p1 });

      const meta = makeShardedMeta('feedhash', 1, {
        greenhouse: { sha256: 'badhash000000', count: 1, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toContain('SHA-256 mismatch');
      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });

    it('one failed shard causes zero writes even if others succeed', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const p2 = makePosting({ id: 'p2', source: 'lever' });
      const gh = await makeShardWithHash('greenhouse', { p1 });
      const lv = await makeShardWithHash('lever', { p2 });

      const meta = makeShardedMeta('feedhash', 2, {
        greenhouse: { sha256: gh.sha256, count: gh.count, updated_at: '2026-08-12T00:00:00Z' },
        lever: { sha256: 'wrong_hash', count: lv.count, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'lever.json': { ok: true, rawText: lv.text },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toBeDefined();
      expect(result.error).toContain('lever');

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });

    it('handles flat-to-sharded transition', async () => {
      const flatMeta = makeMeta('flathash', 1);
      const flatFeed = makeFeed({ p1: makePosting({ id: 'p1', source: 'greenhouse' }) });

      mockFetchResponses({
        'meta.json': { ok: true, body: flatMeta },
        'feed.json': { ok: true, body: flatFeed },
      });

      const flatResult = await syncFeed(db, '/test');
      expect(flatResult.newPostingIds).toEqual(['p1']);
      expect(getStoredMetaHash()).toBe('flathash');

      vi.restoreAllMocks();

      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const p2 = makePosting({ id: 'p2', source: 'lever' });
      const gh = await makeShardWithHash('greenhouse', { p1 });
      const lv = await makeShardWithHash('lever', { p2 });

      const shardedMeta = makeShardedMeta('shardedhash', 2, {
        greenhouse: { sha256: gh.sha256, count: gh.count, updated_at: '2026-08-12T00:00:00Z' },
        lever: { sha256: lv.sha256, count: lv.count, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: shardedMeta },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'lever.json': { ok: true, rawText: lv.text },
        'index.json': { ok: false, body: null },
      });

      const shardedResult = await syncFeed(db, '/test');

      expect(shardedResult.error).toBeUndefined();
      expect(shardedResult.skipped).toBe(false);
      expect(shardedResult.newPostingIds).toContain('p2');
      expect(getStoredMetaHash()).toBe('shardedhash');

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache ORDER BY id');
      expect(rows).toHaveLength(2);
    });

    it('skips unchanged shards and only fetches changed ones', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const p2 = makePosting({ id: 'p2', source: 'lever' });
      const gh = await makeShardWithHash('greenhouse', { p1 });
      const lv = await makeShardWithHash('lever', { p2 });

      const meta1 = makeShardedMeta('hash1', 2, {
        greenhouse: { sha256: gh.sha256, count: gh.count, updated_at: '2026-08-12T00:00:00Z' },
        lever: { sha256: lv.sha256, count: lv.count, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta1 },
        'greenhouse.json': { ok: true, rawText: gh.text },
        'lever.json': { ok: true, rawText: lv.text },
        'index.json': { ok: false, body: null },
      });

      await syncFeed(db, '/test');
      vi.restoreAllMocks();

      const p2updated = makePosting({ id: 'p2', source: 'lever', title: 'Updated Role' });
      const lvUpdated = await makeShardWithHash('lever', { p2: p2updated });

      const meta2 = makeShardedMeta('hash2', 2, {
        greenhouse: { sha256: gh.sha256, count: gh.count, updated_at: '2026-08-12T00:00:00Z' },
        lever: { sha256: lvUpdated.sha256, count: lvUpdated.count, updated_at: '2026-08-13T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta2 },
        'lever.json': { ok: true, rawText: lvUpdated.text },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');
      expect(result.error).toBeUndefined();

      const fetchCalls = vi.mocked(fetch).mock.calls.map((c) => c[0] as string);
      expect(fetchCalls.some((u) => u.includes('greenhouse.json'))).toBe(false);
      expect(fetchCalls.some((u) => u.includes('lever.json'))).toBe(true);
    });

    it('rejects shard HTTP failure — zero writes', async () => {
      const p1 = makePosting({ id: 'p1', source: 'greenhouse' });
      const gh = await makeShardWithHash('greenhouse', { p1 });

      const meta = makeShardedMeta('feedhash', 1, {
        greenhouse: { sha256: gh.sha256, count: gh.count, updated_at: '2026-08-12T00:00:00Z' },
      });

      mockFetchResponses({
        'meta.json': { ok: true, body: meta },
        'greenhouse.json': { ok: false, body: null, status: 500 },
        'index.json': { ok: false, body: null },
      });

      const result = await syncFeed(db, '/test');

      expect(result.error).toBeDefined();
      expect(result.error).toContain('greenhouse');
      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });
  });
});

describe('notifications', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  describe('getNewPostingSummaries', () => {
    it('returns summaries for notifiable postings', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['p1', JSON.stringify({ title: 'SWE Intern', company: 'Ramp', location: 'NYC' }), now],
      );

      const summaries = await getNewPostingSummaries(db, ['p1']);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.title).toBe('SWE Intern');
      expect(summaries[0]!.company).toBe('Ramp');
      expect(summaries[0]!.location).toBe('NYC');
    });

    it('excludes ineligible postings', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, eligibility, synced_at) VALUES (?, ?, ?, ?)',
        [
          'p1',
          JSON.stringify({ title: 'Role A', company: 'Co', location: '' }),
          JSON.stringify({ verdict: 'ineligible', reasons: ['requires clearance'] }),
          now,
        ],
      );

      const summaries = await getNewPostingSummaries(db, ['p1']);
      expect(summaries).toHaveLength(0);
    });

    it('includes postings with null eligibility (unclear)', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['p1', JSON.stringify({ title: 'Role A', company: 'Co', location: '' }), now],
      );

      const summaries = await getNewPostingSummaries(db, ['p1']);
      expect(summaries).toHaveLength(1);
    });

    it('includes postings with eligible verdict', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, eligibility, synced_at) VALUES (?, ?, ?, ?)',
        [
          'p1',
          JSON.stringify({ title: 'Role A', company: 'Co', location: '' }),
          JSON.stringify({ verdict: 'eligible', reasons: [] }),
          now,
        ],
      );

      const summaries = await getNewPostingSummaries(db, ['p1']);
      expect(summaries).toHaveLength(1);
    });

    it('skips nonexistent posting IDs', async () => {
      const summaries = await getNewPostingSummaries(db, ['nonexistent']);
      expect(summaries).toHaveLength(0);
    });
  });

  describe('fireNewPostingNotifications', () => {
    it('fires individual notifications when count <= 15', async () => {
      const now = '2026-08-12T00:00:00Z';
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `p${String(i)}`;
        ids.push(id);
        await db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          [id, JSON.stringify({ title: `Role ${String(i)}`, company: 'Co', location: 'NYC' }), now],
        );
      }

      const notifications: Array<{ title: string; options: NotificationOptions }> = [];
      vi.stubGlobal('Notification', class {
        static permission = 'granted' as NotificationPermission;
        static requestPermission = vi.fn(() => Promise.resolve('granted' as NotificationPermission));
        constructor(title: string, options?: NotificationOptions) {
          notifications.push({ title, options: options ?? {} });
        }
      });

      const count = await fireNewPostingNotifications(db, ids);
      expect(count).toBe(5);
      expect(notifications).toHaveLength(5);
      expect(notifications[0]!.title).toBe('Role 0');
    });

    it('fires single summary when count > 15', async () => {
      const now = '2026-08-12T00:00:00Z';
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = `p${String(i)}`;
        ids.push(id);
        await db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          [id, JSON.stringify({ title: `Role ${String(i)}`, company: 'Co', location: 'NYC' }), now],
        );
      }

      const notifications: Array<{ title: string; options: NotificationOptions }> = [];
      vi.stubGlobal('Notification', class {
        static permission = 'granted' as NotificationPermission;
        static requestPermission = vi.fn(() => Promise.resolve('granted' as NotificationPermission));
        constructor(title: string, options?: NotificationOptions) {
          notifications.push({ title, options: options ?? {} });
        }
      });

      const count = await fireNewPostingNotifications(db, ids);
      expect(count).toBe(20);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.title).toBe('Nightjar');
      expect(notifications[0]!.options.body).toContain('20 new postings');
    });

    it('returns count but fires nothing when permission denied', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['p1', JSON.stringify({ title: 'Role', company: 'Co', location: '' }), now],
      );

      vi.stubGlobal('Notification', class {
        static permission = 'denied' as NotificationPermission;
        static requestPermission = vi.fn(() => Promise.resolve('denied' as NotificationPermission));
        constructor() { /* no-op */ }
      });

      const count = await fireNewPostingNotifications(db, ['p1']);
      expect(count).toBe(1);
    });

    it('returns 0 for empty posting list', async () => {
      const count = await fireNewPostingNotifications(db, []);
      expect(count).toBe(0);
    });

    it('excludes ineligible from notification count', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        'INSERT INTO postings_cache (id, data, eligibility, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', JSON.stringify({ title: 'R1', company: 'Co', location: '' }),
         JSON.stringify({ verdict: 'ineligible', reasons: ['x'] }), now],
      );
      await db.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['p2', JSON.stringify({ title: 'R2', company: 'Co', location: '' }), now],
      );

      const notifications: Array<{ title: string }> = [];
      vi.stubGlobal('Notification', class {
        static permission = 'granted' as NotificationPermission;
        static requestPermission = vi.fn(() => Promise.resolve('granted' as NotificationPermission));
        constructor(title: string) { notifications.push({ title }); }
      });

      const count = await fireNewPostingNotifications(db, ['p1', 'p2']);
      expect(count).toBe(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.title).toBe('R2');
    });
  });
});
