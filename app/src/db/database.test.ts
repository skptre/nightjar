import { describe, it, expect, beforeEach } from 'vitest';
import { NightjarDB } from './database';
import { runMigrations, getSchemaVersion, type Migration } from './migrations';

describe('NightjarDB', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('schema creation', () => {
    it('creates all tables on fresh database', () => {
      const tables = db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const names = tables.map((t) => t.name);
      expect(names).toContain('schema_version');
      expect(names).toContain('postings_cache');
      expect(names).toContain('applications');
    });

    it('sets initial schema version to 1', () => {
      const version = getSchemaVersion(db);
      expect(version).toBe(1);
    });

    it('creates indexes', () => {
      const indexes = db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const names = indexes.map((i) => i.name);
      expect(names).toContain('idx_postings_score');
      expect(names).toContain('idx_postings_category');
      expect(names).toContain('idx_applications_status');
    });
  });

  describe('posting round-trip', () => {
    it('inserts and queries a posting correctly', () => {
      const now = '2026-08-12T00:00:00Z';
      const postingData = JSON.stringify({
        id: 'abc123',
        company: 'Ramp',
        title: 'SWE Intern',
      });

      db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at)
         VALUES (?, ?, ?, ?)`,
        ['abc123', postingData, now, now],
      );

      const row = db.queryOne<{
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

    it('handles all nullable fields correctly', () => {
      db.run(
        `INSERT INTO postings_cache (id, data, synced_at)
         VALUES (?, ?, ?)`,
        ['test1', '{}', '2026-01-01T00:00:00Z'],
      );

      const row = db.queryOne<{
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
    it('inserts and queries application status', () => {
      const now = '2026-08-12T00:00:00Z';

      db.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['p1', '{}', now],
      );
      db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        ['p1', 'saved', now, now],
      );

      const app = db.queryOne<{ posting_id: string; status: string }>(
        'SELECT posting_id, status FROM applications WHERE posting_id = ?',
        ['p1'],
      );

      expect(app).toBeDefined();
      expect(app!.posting_id).toBe('p1');
      expect(app!.status).toBe('saved');
    });

    it('defaults status to new', () => {
      const now = '2026-08-12T00:00:00Z';
      db.run(
        `INSERT INTO applications (posting_id, created_at, updated_at)
         VALUES (?, ?, ?)`,
        ['p2', now, now],
      );

      const app = db.queryOne<{ status: string }>(
        'SELECT status FROM applications WHERE posting_id = ?',
        ['p2'],
      );
      expect(app!.status).toBe('new');
    });
  });

  describe('export and import', () => {
    it('preserves data through export/import cycle', async () => {
      const now = '2026-08-12T00:00:00Z';
      db.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['exp1', '{"title":"Test"}', now],
      );
      db.run(
        `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
        ['exp2', '{"title":"Test2"}', now],
      );

      const exported = db.export();
      const db2 = await NightjarDB.createFromBytes(exported);

      const rows = db2.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache ORDER BY id',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe('exp1');
      expect(rows[0]!.data).toBe('{"title":"Test"}');
      expect(rows[1]!.id).toBe('exp2');
      expect(rows[1]!.data).toBe('{"title":"Test2"}');

      db2.close();
    });

    it('preserves schema version through export/import', async () => {
      const exported = db.export();
      const db2 = await NightjarDB.createFromBytes(exported);

      expect(getSchemaVersion(db2)).toBe(1);
      db2.close();
    });
  });

  describe('migration runner', () => {
    it('applies pending migrations in order', () => {
      const testMigrations: Migration[] = [
        {
          version: 2,
          sql: 'ALTER TABLE postings_cache ADD COLUMN test_col TEXT;',
        },
        {
          version: 3,
          sql: 'ALTER TABLE postings_cache ADD COLUMN test_col2 INTEGER;',
        },
      ];

      runMigrations(db, testMigrations);

      expect(getSchemaVersion(db)).toBe(3);

      db.run(
        `INSERT INTO postings_cache (id, data, synced_at, test_col, test_col2)
         VALUES (?, ?, ?, ?, ?)`,
        ['m1', '{}', '2026-01-01T00:00:00Z', 'hello', 42],
      );

      const row = db.queryOne<{ test_col: string; test_col2: number }>(
        'SELECT test_col, test_col2 FROM postings_cache WHERE id = ?',
        ['m1'],
      );
      expect(row!.test_col).toBe('hello');
      expect(row!.test_col2).toBe(42);
    });

    it('skips already-applied migrations', () => {
      const testMigrations: Migration[] = [
        {
          version: 2,
          sql: 'ALTER TABLE postings_cache ADD COLUMN skip_test TEXT;',
        },
      ];

      runMigrations(db, testMigrations);
      expect(getSchemaVersion(db)).toBe(2);

      runMigrations(db, testMigrations);
      expect(getSchemaVersion(db)).toBe(2);
    });

    it('applies only migrations newer than current version', () => {
      const batch1: Migration[] = [
        { version: 2, sql: 'ALTER TABLE postings_cache ADD COLUMN v2_col TEXT;' },
      ];
      runMigrations(db, batch1);
      expect(getSchemaVersion(db)).toBe(2);

      const batch2: Migration[] = [
        { version: 2, sql: 'ALTER TABLE postings_cache ADD COLUMN v2_col TEXT;' },
        { version: 3, sql: 'ALTER TABLE postings_cache ADD COLUMN v3_col TEXT;' },
      ];
      runMigrations(db, batch2);
      expect(getSchemaVersion(db)).toBe(3);

      db.run(
        `INSERT INTO postings_cache (id, data, synced_at, v2_col, v3_col)
         VALUES (?, ?, ?, ?, ?)`,
        ['check1', '{}', '2026-01-01T00:00:00Z', 'a', 'b'],
      );
      const row = db.queryOne<{ v2_col: string; v3_col: string }>(
        'SELECT v2_col, v3_col FROM postings_cache WHERE id = ?',
        ['check1'],
      );
      expect(row!.v2_col).toBe('a');
      expect(row!.v3_col).toBe('b');
    });
  });

  describe('transactions', () => {
    it('commits all writes atomically', () => {
      db.transaction(() => {
        db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          ['tx1', '{}', '2026-01-01T00:00:00Z'],
        );
        db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          ['tx2', '{}', '2026-01-01T00:00:00Z'],
        );
      });

      const rows = db.query<{ id: string }>('SELECT id FROM postings_cache ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe('tx1');
      expect(rows[1]!.id).toBe('tx2');
    });

    it('rolls back on error', () => {
      expect(() => {
        db.transaction(() => {
          db.run(
            'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
            ['rb1', '{}', '2026-01-01T00:00:00Z'],
          );
          throw new Error('intentional error');
        });
      }).toThrow('intentional error');

      const rows = db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(0);
    });
  });

  describe('concurrent writes', () => {
    it('rapid sequential writes do not corrupt data', () => {
      for (let i = 0; i < 20; i++) {
        db.run(
          'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
          [`rapid${String(i)}`, `{"n":${String(i)}}`, '2026-01-01T00:00:00Z'],
        );
      }

      const rows = db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toHaveLength(20);

      for (let i = 0; i < 20; i++) {
        const row = db.queryOne<{ data: string }>(
          'SELECT data FROM postings_cache WHERE id = ?',
          [`rapid${String(i)}`],
        );
        expect(row!.data).toBe(`{"n":${String(i)}}`);
      }
    });
  });

  describe('query helpers', () => {
    it('query returns empty array when no results', () => {
      const rows = db.query<{ id: string }>('SELECT id FROM postings_cache');
      expect(rows).toEqual([]);
    });

    it('queryOne returns undefined when no results', () => {
      const row = db.queryOne<{ id: string }>('SELECT id FROM postings_cache WHERE id = ?', [
        'nonexistent',
      ]);
      expect(row).toBeUndefined();
    });

    it('query returns multiple rows correctly', () => {
      db.transaction(() => {
        for (let i = 1; i <= 5; i++) {
          db.run(
            'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
            [`q${String(i)}`, '{}', '2026-01-01T00:00:00Z'],
          );
        }
      });

      const rows = db.query<{ id: string }>('SELECT id FROM postings_cache ORDER BY id');
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    });
  });
});
