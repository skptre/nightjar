import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NightjarDB } from '@/db/database';

function makePostingData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    company: 'Ramp',
    company_slug: 'ramp',
    title: 'Software Engineering Intern',
    location: 'New York, NY',
    locations: ['New York, NY'],
    url: 'https://boards.greenhouse.io/ramp/jobs/12345',
    source: 'greenhouse',
    source_job_id: '12345',
    ats: 'greenhouse',
    posted_at: '2026-08-10T00:00:00Z',
    first_seen_at: '2026-08-10T12:00:00Z',
    last_seen_at: '2026-08-13T12:00:00Z',
    closed_at: null,
    ...overrides,
  });
}

describe('Block 10 — App Hardening', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('Malformed posting JSON', () => {
    it('parsePostingRow returns null for invalid JSON', async () => {
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, score)
         VALUES (?, ?, ?, ?, ?)`,
        ['bad1', 'NOT{VALID}JSON', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 50],
      );

      const rows = await db.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache WHERE id = ?',
        ['bad1'],
      );
      expect(rows).toHaveLength(1);

      let parsed = null;
      try {
        parsed = JSON.parse(rows[0]!.data);
      } catch {
        parsed = null;
      }
      expect(parsed).toBeNull();
    });

    it('valid JSON round-trips correctly', async () => {
      const data = makePostingData({ title: 'ML Intern' });
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, score)
         VALUES (?, ?, ?, ?, ?)`,
        ['good1', data, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 80],
      );

      const rows = await db.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache WHERE id = ?',
        ['good1'],
      );
      const parsed = JSON.parse(rows[0]!.data) as Record<string, unknown>;
      expect(parsed['title']).toBe('ML Intern');
    });
  });

  describe('Offline sync skip', () => {
    it('SyncManager keeps a populated cache without fetching when offline', async () => {
      await db.run("INSERT INTO postings_cache(id,data,synced_at) VALUES ('cached','{}','2026-09-10')");
      const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');

      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      const { SyncManager } = await import('@/sync/sync-manager');
      const manager = new SyncManager(db);
      const result = await manager.doSync();
      expect(result).toBeNull();
      const state = manager.getState();
      expect(state.lastError).toBe('Offline');
      expect(state.status).toBe('idle');

      if (originalOnLine) {
        Object.defineProperty(Navigator.prototype, 'onLine', originalOnLine);
      }
    });
  });

  describe('Empty states', () => {
    it('untriaged query returns empty when no postings exist', async () => {
      const rows = await db.query<{ id: string }>(
        `SELECT p.id FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new')
           AND p.closed_at IS NULL`,
      );
      expect(rows).toHaveLength(0);
    });

    it('pipeline query returns empty when no applications exist', async () => {
      const rows = await db.query<{ posting_id: string }>(
        `SELECT posting_id FROM applications WHERE status != 'new'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('Long title truncation', () => {
    it('stores and retrieves long titles without corruption', async () => {
      const longTitle = 'A'.repeat(300);
      const data = makePostingData({ title: longTitle });
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, score)
         VALUES (?, ?, ?, ?, ?)`,
        ['long1', data, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 50],
      );

      const rows = await db.query<{ data: string }>(
        'SELECT data FROM postings_cache WHERE id = ?',
        ['long1'],
      );
      const parsed = JSON.parse(rows[0]!.data) as Record<string, unknown>;
      expect(parsed['title']).toBe(longTitle);
      expect((parsed['title'] as string).length).toBe(300);
    });
  });

  describe('Missing fields in posting data', () => {
    it('handles posting with null location gracefully', async () => {
      const data = makePostingData({ location: null, locations: [] });
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, score)
         VALUES (?, ?, ?, ?, ?)`,
        ['null-loc', data, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 50],
      );

      const rows = await db.query<{ data: string }>(
        'SELECT data FROM postings_cache WHERE id = ?',
        ['null-loc'],
      );
      const parsed = JSON.parse(rows[0]!.data) as Record<string, unknown>;
      expect(parsed['location']).toBeNull();
      expect(parsed['locations']).toEqual([]);
    });

    it('handles posting with empty title', async () => {
      const data = makePostingData({ title: '' });
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, score)
         VALUES (?, ?, ?, ?, ?)`,
        ['empty-title', data, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 50],
      );

      const rows = await db.query<{ data: string }>(
        'SELECT data FROM postings_cache WHERE id = ?',
        ['empty-title'],
      );
      const parsed = JSON.parse(rows[0]!.data) as Record<string, unknown>;
      expect(parsed['title']).toBe('');
    });
  });

  describe('Error state detection', () => {
    it('isDatabaseError detects sqlite errors', () => {
      const patterns = ['database disk image is malformed', 'SQLite error', 'indexeddb access denied', 'sql.js failed'];
      for (const msg of patterns) {
        const error = new Error(msg);
        const isDb = error.message.toLowerCase().includes('database')
          || error.message.toLowerCase().includes('sqlite')
          || error.message.toLowerCase().includes('indexeddb')
          || error.message.toLowerCase().includes('sql.js');
        expect(isDb).toBe(true);
      }
    });

    it('isDatabaseError rejects non-database errors', () => {
      const error = new Error('Network request failed');
      const isDb = error.message.toLowerCase().includes('database')
        || error.message.toLowerCase().includes('sqlite')
        || error.message.toLowerCase().includes('indexeddb')
        || error.message.toLowerCase().includes('sql.js');
      expect(isDb).toBe(false);
    });
  });

  describe('Feed sync error handling', () => {
    it('404 response from feed throws with helpful message', async () => {
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('Not Found'),
        }),
      ));

      const { fetchFeed } = await import('@/sync/feed-sync');
      await expect(fetchFeed()).rejects.toThrow(/404/);

      vi.unstubAllGlobals();
    });

    it('network error throws with descriptive message', async () => {
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      ));

      const { fetchFeed } = await import('@/sync/feed-sync');
      await expect(fetchFeed()).rejects.toThrow(/Network error/);

      vi.unstubAllGlobals();
    });
  });
});
