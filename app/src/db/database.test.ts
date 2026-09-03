import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { NightjarDB } from './database';
import { runMigrations, getSchemaVersion, type Migration } from './migrations';

describe('NightjarDB', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('schema creation', () => {
    it('creates all tables on fresh database', async () => {
      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const names = tables.map((t) => t.name);
      expect(names).toContain('schema_version');
      expect(names).toContain('postings_cache');
      expect(names).toContain('applications');
    });

    it('sets initial schema version to 3', async () => {
      const version = await getSchemaVersion(db);
      expect(version).toBe(3);
    });

    it('stores multi-label category tags', async () => {
      const columns = await db.query<{ name: string }>('PRAGMA table_info(postings_cache)');
      expect(columns.map((column) => column.name)).toContain('category_tags');
    });

    it('creates indexes', async () => {
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const names = indexes.map((i) => i.name);
      expect(names).toContain('idx_postings_score');
      expect(names).toContain('idx_postings_category');
      expect(names).toContain('idx_applications_status');
    });
  });

  describe('posting round-trip', () => {
    it('inserts and queries a posting correctly', async () => {
      const now = '2026-08-12T00:00:00Z';
      const postingData = JSON.stringify({
        id: 'abc123',
        company: 'Ramp',
        title: 'SWE Intern',
      });

      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at)
         VALUES (?, ?, ?, ?)`,
        ['abc123', postingData, now, now],
      );

      const row = await db.queryOne<{
        id: string;
        data: string;
        first_seen_at: string;
        synced_at: string;
        description: string | null;
        score: number | null;
      }>('SELECT id, data, first_seen_at, synced_at, description, score FROM postings_cache WHERE id = ?', [
        'abc123',
      ]);

      expect(row).toBeDefined();
      expect(row!.id).toBe('abc123');
      expect(row!.data).toBe(postingData);
      expect(row!.first_seen_at).toBe(now);
      expect(row!.synced_at).toBe(now);
      expect(row!.description).toBeNull();
      expect(row!.score).toBeNull();
    });

    it('handles all nullable fields correctly', async () => {
      await db.run(
        `INSERT INTO postings_cache (id, data, synced_at)
         VALUES (?, ?, ?)`,
        ['test1', '{}', '2026-01-01T00:00:00Z'],
      );

      const row = await db.queryOne<{
        id: string;
        description: string | null;
        closed_at: string | null;
        category: string | null;
        term: string | null;
        eligibility: string | null;
        score: number | null;
        score_breakdown: string | null;
      }>(
        `SELECT id, description, closed_at, category, term,
                eligibility, score, score_breakdown
         FROM postings_cache WHERE id = ?`,
        ['test1'],
      );

      expect(row).toBeDefined();
      expect(row!.description).toBeNull();
      expect(row!.closed_at).toBeNull();
      expect(row!.category).toBeNull();
      expect(row!.term).toBeNull();
      expect(row!.eligibility).toBeNull();
      expect(row!.score).toBeNull();
      expect(row!.score_breakdown).toBeNull();
    });
  });

  describe('application tracking', () => {
    it('inserts and queries application status', async () => {
      const now = '2026-08-12T00:00:00Z';

      await db.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['p1', '{}', now],
      );
      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        ['p1', 'saved', now, now],
      );

      const app = await db.queryOne<{ posting_id: string; status: string }>(
        'SELECT posting_id, status FROM applications WHERE posting_id = ?',
        ['p1'],
      );

      expect(app).toBeDefined();
      expect(app!.posting_id).toBe('p1');
      expect(app!.status).toBe('saved');
    });

    it('defaults status to new', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        `INSERT INTO applications (posting_id, created_at, updated_at)
         VALUES (?, ?, ?)`,
        ['p2', now, now],
      );

      const app = await db.queryOne<{ status: string }>(
        'SELECT status FROM applications WHERE posting_id = ?',
        ['p2'],
      );
      expect(app!.status).toBe('new');
    });
  });

  describe('export and import', () => {
    it('preserves data through export/import cycle', async () => {
      const now = '2026-08-12T00:00:00Z';
      await db.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['exp1', '{"title":"Test"}', now],
      );
      await db.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['exp2', '{"title":"Test2"}', now],
      );

      const exported = db.export();
      const db2 = await NightjarDB.createFromBytes(exported);

      const rows = await db2.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache ORDER BY id',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe('exp1');
      expect(rows[0]!.data).toBe('{"title":"Test"}');
      expect(rows[1]!.id).toBe('exp2');
      expect(rows[1]!.data).toBe('{"title":"Test2"}');

      await db2.close();
    });

    it('preserves schema version through export/import', async () => {
      const exported = db.export();
      const db2 = await NightjarDB.createFromBytes(exported);

      expect(await getSchemaVersion(db2)).toBe(3);
      await db2.close();
    });
  });

  describe('migration runner', () => {
    it('migrates a version 2 cache to multi-label categories', async () => {
      const SQL = await initSqlJs();
      const legacy = new SQL.Database();
      legacy.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (2);
        CREATE TABLE postings_cache (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          description TEXT,
          first_seen_at TEXT,
          closed_at TEXT,
          category TEXT,
          term TEXT,
          eligibility TEXT,
          score REAL,
          score_breakdown TEXT,
          synced_at TEXT NOT NULL
        );
        INSERT INTO postings_cache (id, data, category, synced_at)
        VALUES ('legacy-ml', '{}', 'ml', '2026-09-01T00:00:00Z');
      `);

      const migrated = await NightjarDB.createFromBytes(new Uint8Array(legacy.export()));
      legacy.close();

      expect(await getSchemaVersion(migrated)).toBe(3);
      const columns = await migrated.query<{ name: string }>('PRAGMA table_info(postings_cache)');
      expect(columns.map((column) => column.name)).toContain('category_tags');
      const row = await migrated.queryOne<{ category: string; category_tags: string | null }>(
        'SELECT category, category_tags FROM postings_cache WHERE id = ?',
        ['legacy-ml'],
      );
      expect(row).toEqual({ category: 'data-ml', category_tags: null });
      await migrated.close();
    });

    it('applies pending migrations in order', async () => {
      const testMigrations: Migration[] = [
        {
          version: 4,
          sql: 'ALTER TABLE postings_cache ADD COLUMN test_col TEXT;',
        },
        {
          version: 5,
          sql: 'ALTER TABLE postings_cache ADD COLUMN test_col2 INTEGER;',
        },
      ];

      await runMigrations(db, testMigrations);

      expect(await getSchemaVersion(db)).toBe(5);

      await db.run(
        `INSERT INTO postings_cache (id, data, synced_at, test_col, test_col2)
         VALUES (?, ?, ?, ?, ?)`,
        ['m1', '{}', '2026-01-01T00:00:00Z', 'hello', 42],
      );

      const row = await db.queryOne<{ test_col: string; test_col2: number }>(
        'SELECT test_col, test_col2 FROM postings_cache WHERE id = ?',
        ['m1'],
      );
      expect(row!.test_col).toBe('hello');
      expect(row!.test_col2).toBe(42);
    });

    it('skips already-applied migrations', async () => {
      const testMigrations: Migration[] = [
        {
          version: 4,
          sql: 'ALTER TABLE postings_cache ADD COLUMN skip_test TEXT;',
        },
      ];

      await runMigrations(db, testMigrations);
      expect(await getSchemaVersion(db)).toBe(4);

      await runMigrations(db, testMigrations);
      expect(await getSchemaVersion(db)).toBe(4);
    });

    it('applies only migrations newer than current version', async () => {
      const batch1: Migration[] = [
        { version: 4, sql: 'ALTER TABLE postings_cache ADD COLUMN v3_col TEXT;' },
      ];
      await runMigrations(db, batch1);
      expect(await getSchemaVersion(db)).toBe(4);

      const batch2: Migration[] = [
        { version: 4, sql: 'ALTER TABLE postings_cache ADD COLUMN v3_col TEXT;' },
        { version: 5, sql: 'ALTER TABLE postings_cache ADD COLUMN v4_col TEXT;' },
      ];
      await runMigrations(db, batch2);
      expect(await getSchemaVersion(db)).toBe(5);

      await db.run(
        `INSERT INTO postings_cache (id, data, synced_at, v3_col, v4_col)
         VALUES (?, ?, ?, ?, ?)`,
        ['check1', '{}', '2026-01-01T00:00:00Z', 'a', 'b'],
      );
      const row = await db.queryOne<{ v3_col: string; v4_col: string }>(
        'SELECT v3_col, v4_col FROM postings_cache WHERE id = ?',
        ['check1'],
      );
      expect(row!.v3_col).toBe('a');
      expect(row!.v4_col).toBe('b');
    });
  });

  describe('transactions', () => {
    it('commits all writes atomically', async () => {
      await db.transaction(async () => {
        await db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          ['tx1', '{}', '2026-01-01T00:00:00Z'],
        );
        await db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          ['tx2', '{}', '2026-01-01T00:00:00Z'],
        );
      });

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe('tx1');
      expect(rows[1]!.id).toBe('tx2');
    });

    it('rolls back on error', async () => {
      await expect(
        db.transaction(async () => {
          await db.run(
            'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
            ['rb1', '{}', '2026-01-01T00:00:00Z'],
          );
          throw new Error('intentional error');
        }),
      ).rejects.toThrow('intentional error');

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });
  });

  describe('concurrent writes', () => {
    it('rapid sequential writes do not corrupt data', async () => {
      for (let i = 0; i < 20; i++) {
        await db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          [`rapid${String(i)}`, `{"n":${String(i)}}`, '2026-01-01T00:00:00Z'],
        );
      }

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(20);

      for (let i = 0; i < 20; i++) {
        const row = await db.queryOne<{ data: string }>(
          'SELECT data FROM postings_cache WHERE id = ?',
          [`rapid${String(i)}`],
        );
        expect(row!.data).toBe(`{"n":${String(i)}}`);
      }
    });
  });

  describe('query helpers', () => {
    it('query returns empty array when no results', async () => {
      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toEqual([]);
    });

    it('queryOne returns undefined when no results', async () => {
      const row = await db.queryOne<{ id: string }>('SELECT id FROM postings_cache WHERE id = ?', [
        'nonexistent',
      ]);
      expect(row).toBeUndefined();
    });

    it('query returns multiple rows correctly', async () => {
      await db.transaction(async () => {
        for (let i = 1; i <= 5; i++) {
          await db.run(
            'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
            [`q${String(i)}`, '{}', '2026-01-01T00:00:00Z'],
          );
        }
      });

      const rows = await db.query<{ id: string }>('SELECT id FROM postings_cache ORDER BY id');
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    });
  });

  describe('browser-to-native migration', () => {
    it('migrates postings and applications from sql.js bytes to target', async () => {
      const source = await NightjarDB.createInMemory();
      const now = '2026-08-25T12:00:00Z';
      await source.run(
        `INSERT INTO postings_cache (id, data, description, category, score, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['mig1', '{"title":"SWE Intern"}', 'Build things', 'swe', 85, now],
      );
      await source.run(
        `INSERT INTO postings_cache (id, data, synced_at)
         VALUES (?, ?, ?)`,
        ['mig2', '{"title":"ML Engineer"}', now],
      );
      await source.run(
        `INSERT INTO applications (posting_id, status, applied_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['mig1', 'applied', now, now, now],
      );

      const exported = source.export();
      const target = await NightjarDB.createInMemory();

      const { migrateFromBrowser } = await import('./migrate-from-browser');
      const migrated = await migrateFromBrowser(target, async () => exported);
      expect(migrated).toBe(true);

      const postings = await target.query<{ id: string; data: string; description: string | null; category: string | null; score: number | null }>(
        'SELECT id, data, description, category, score FROM postings_cache ORDER BY id',
      );
      expect(postings).toHaveLength(2);
      expect(postings[0]!.id).toBe('mig1');
      expect(postings[0]!.data).toBe('{"title":"SWE Intern"}');
      expect(postings[0]!.description).toBe('Build things');
      expect(postings[0]!.category).toBe('swe');
      expect(postings[0]!.score).toBe(85);
      expect(postings[1]!.id).toBe('mig2');
      expect(postings[1]!.description).toBeNull();

      const apps = await target.query<{ posting_id: string; status: string; applied_at: string | null }>(
        'SELECT posting_id, status, applied_at FROM applications',
      );
      expect(apps).toHaveLength(1);
      expect(apps[0]!.posting_id).toBe('mig1');
      expect(apps[0]!.status).toBe('applied');
      expect(apps[0]!.applied_at).toBe(now);

      await source.close();
      await target.close();
    });

    it('skips migration when target already has data', async () => {
      const target = await NightjarDB.createInMemory();
      const now = '2026-08-25T12:00:00Z';
      await target.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['existing', '{}', now],
      );

      const { migrateFromBrowser } = await import('./migrate-from-browser');
      const migrated = await migrateFromBrowser(target, async () => new Uint8Array([1, 2, 3]));
      expect(migrated).toBe(false);

      await target.close();
    });

    it('skips migration when no browser data exists', async () => {
      const target = await NightjarDB.createInMemory();

      const { migrateFromBrowser } = await import('./migrate-from-browser');
      const migrated = await migrateFromBrowser(target, async () => null);
      expect(migrated).toBe(false);

      await target.close();
    });

    it('skips migration when browser database has no rows', async () => {
      const source = await NightjarDB.createInMemory();
      const exported = source.export();
      const target = await NightjarDB.createInMemory();

      const { migrateFromBrowser } = await import('./migrate-from-browser');
      const migrated = await migrateFromBrowser(target, async () => exported);
      expect(migrated).toBe(false);

      await source.close();
      await target.close();
    });
  });
});
