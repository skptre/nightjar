import { describe, it, expect, beforeEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import { upsertPostings, type FeedData, type FeedPosting } from '@/sync/feed-sync';

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

async function insertPosting(
  db: NightjarDB,
  id: string,
  overrides: { data?: Record<string, unknown> } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, category, term, eligibility, score, score_breakdown, synced_at)
     VALUES (?, ?, ?, NULL, 'swe', 'summer_2027', '{}', 75, '{}', ?)`,
    [id, makePostingData(overrides.data ?? {}), '2026-08-10T12:00:00Z', '2026-08-13T12:00:00Z'],
  );
}

async function createApplication(
  db: NightjarDB,
  postingId: string,
  status: string,
  overrides: {
    applied_at?: string | null;
    deadline?: string | null;
    next_action?: string | null;
    next_action_at?: string | null;
  } = {},
): Promise<void> {
  const now = '2026-08-13T14:00:00Z';
  await db.run(
    `INSERT INTO applications (posting_id, status, applied_at, deadline, next_action, next_action_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      postingId,
      status,
      overrides.applied_at ?? null,
      overrides.deadline ?? null,
      overrides.next_action ?? null,
      overrides.next_action_at ?? null,
      now,
      now,
    ],
  );
}

describe('Calendar View Data Layer', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('application events', () => {
    it('deadline from application appears as event', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'saved', {
        deadline: '2026-09-15',
      });

      const rows = await db.query<{
        posting_id: string;
        data: string;
        deadline: string | null;
      }>(
        `SELECT a.posting_id, p.data, a.deadline
         FROM applications a
         INNER JOIN postings_cache p ON p.id = a.posting_id
         WHERE a.deadline IS NOT NULL`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.deadline).toBe('2026-09-15');
    });

    it('applied_at date appears as applied event', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'applied', {
        applied_at: '2026-08-20T10:00:00Z',
      });

      const rows = await db.query<{
        posting_id: string;
        applied_at: string | null;
      }>(
        `SELECT a.posting_id, a.applied_at
         FROM applications a
         WHERE a.applied_at IS NOT NULL`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.applied_at?.slice(0, 10)).toBe('2026-08-20');
    });

    it('next_action_at appears as next action event', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'phone', {
        next_action: 'Phone screen',
        next_action_at: '2026-09-01',
      });

      const rows = await db.query<{
        posting_id: string;
        next_action: string | null;
        next_action_at: string | null;
      }>(
        `SELECT a.posting_id, a.next_action, a.next_action_at
         FROM applications a
         WHERE a.next_action_at IS NOT NULL AND a.next_action IS NOT NULL`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.next_action).toBe('Phone screen');
      expect(rows[0]?.next_action_at).toBe('2026-09-01');
    });

    it('skipped and new status postings excluded from calendar events', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-2', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'skipped');
      await createApplication(db, 'ramp-2', 'new');

      const rows = await db.query<{ posting_id: string }>(
        `SELECT a.posting_id
         FROM applications a
         INNER JOIN postings_cache p ON p.id = a.posting_id
         WHERE a.status != 'new' AND a.status != 'skipped'`,
      );

      expect(rows).toHaveLength(0);
    });

    it('multiple events from different applications', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'stripe-1', { data: { company: 'Stripe', company_slug: 'stripe' } });
      await createApplication(db, 'ramp-1', 'applied', {
        applied_at: '2026-08-20T10:00:00Z',
        deadline: '2026-09-15',
      });
      await createApplication(db, 'stripe-1', 'saved', {
        deadline: '2026-09-20',
      });

      const deadlines = await db.query<{ posting_id: string; deadline: string }>(
        `SELECT a.posting_id, a.deadline
         FROM applications a
         WHERE a.deadline IS NOT NULL AND a.status != 'new' AND a.status != 'skipped'
         ORDER BY a.deadline`,
      );

      expect(deadlines).toHaveLength(2);
      expect(deadlines[0]?.deadline).toBe('2026-09-15');
      expect(deadlines[1]?.deadline).toBe('2026-09-20');
    });
  });

  describe('companies_meta', () => {
    it('typical_open dates stored for tiered companies', async () => {
      await db.run(
        'INSERT INTO companies_meta (slug, name, typical_open) VALUES (?, ?, ?)',
        ['ramp', 'Ramp', '2026-09'],
      );
      await db.run(
        'INSERT INTO companies_meta (slug, name, typical_open) VALUES (?, ?, ?)',
        ['stripe', 'Stripe', '2026-08'],
      );
      await db.run(
        'INSERT INTO companies_meta (slug, name, typical_open) VALUES (?, ?, ?)',
        ['plaid', 'Plaid', null],
      );

      const rows = await db.query<{ slug: string; typical_open: string | null }>(
        'SELECT slug, typical_open FROM companies_meta WHERE typical_open IS NOT NULL',
      );

      expect(rows).toHaveLength(2);
      const slugs = rows.map((r) => r.slug).sort();
      expect(slugs).toEqual(['ramp', 'stripe']);
    });

    it('companies_meta upsert via feed sync', async () => {
      const posting: FeedPosting = {
        id: 'abc123',
        company: 'Ramp',
        company_slug: 'ramp',
        title: 'SWE Intern',
        location: 'NYC',
        locations: ['NYC'],
        url: 'https://example.com',
        source: 'greenhouse',
        source_job_id: '1',
        ats: 'greenhouse',
        posted_at: '2026-08-01T00:00:00Z',
        first_seen_at: '2026-08-01T00:00:00Z',
        last_seen_at: '2026-08-12T00:00:00Z',
        closed_at: null,
      };

      const feed: FeedData = {
        updated_at: '2026-08-12T00:00:00Z',
        version: 1,
        count: 1,
        postings: { abc123: posting },
        companies: {
          ramp: { name: 'Ramp', typical_open: '2026-09' },
          stripe: { name: 'Stripe', typical_open: null },
        },
      };

      await upsertPostings(db, feed);

      const rows = await db.query<{ slug: string; name: string; typical_open: string | null }>(
        'SELECT slug, name, typical_open FROM companies_meta ORDER BY slug',
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]?.slug).toBe('ramp');
      expect(rows[0]?.name).toBe('Ramp');
      expect(rows[0]?.typical_open).toBe('2026-09');
      expect(rows[1]?.slug).toBe('stripe');
      expect(rows[1]?.typical_open).toBeNull();
    });

    it('feed without companies field does not crash', async () => {
      const posting: FeedPosting = {
        id: 'abc123',
        company: 'Ramp',
        company_slug: 'ramp',
        title: 'SWE Intern',
        location: 'NYC',
        locations: ['NYC'],
        url: 'https://example.com',
        source: 'greenhouse',
        source_job_id: '1',
        ats: 'greenhouse',
        posted_at: '2026-08-01T00:00:00Z',
        first_seen_at: '2026-08-01T00:00:00Z',
        last_seen_at: '2026-08-12T00:00:00Z',
        closed_at: null,
      };

      const feed: FeedData = {
        updated_at: '2026-08-12T00:00:00Z',
        version: 1,
        count: 1,
        postings: { abc123: posting },
      };

      await upsertPostings(db, feed);

      const rows = await db.query<{ slug: string }>('SELECT slug FROM companies_meta');
      expect(rows).toHaveLength(0);
    });
  });

  describe('add deadline', () => {
    it('updating deadline on application persists correctly', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'saved');

      await db.run(
        'UPDATE applications SET deadline = ?, updated_at = ? WHERE posting_id = ?',
        ['2026-10-01', '2026-08-14T00:00:00Z', 'ramp-1'],
      );

      const row = await db.queryOne<{ deadline: string | null }>(
        'SELECT deadline FROM applications WHERE posting_id = ?',
        ['ramp-1'],
      );
      expect(row?.deadline).toBe('2026-10-01');
    });

    it('adding deadline note appends to existing notes', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'saved');

      await db.run(
        'UPDATE applications SET notes = ? WHERE posting_id = ?',
        ['Existing note', 'ramp-1'],
      );

      const existing = await db.queryOne<{ notes: string | null }>(
        'SELECT notes FROM applications WHERE posting_id = ?',
        ['ramp-1'],
      );

      const newNotes = existing?.notes
        ? `${existing.notes}\nDeadline note: OA due`
        : 'Deadline note: OA due';

      await db.run(
        'UPDATE applications SET notes = ? WHERE posting_id = ?',
        [newNotes, 'ramp-1'],
      );

      const updated = await db.queryOne<{ notes: string | null }>(
        'SELECT notes FROM applications WHERE posting_id = ?',
        ['ramp-1'],
      );
      expect(updated?.notes).toBe('Existing note\nDeadline note: OA due');
    });

    it('only saved/applied/oa/phone/onsite postings eligible for deadline', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-2', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-3', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'saved');
      await createApplication(db, 'ramp-2', 'rejected');
      await createApplication(db, 'ramp-3', 'applied');

      const rows = await db.query<{ posting_id: string }>(
        `SELECT a.posting_id FROM applications a
         WHERE a.status IN ('saved', 'applied', 'oa', 'phone', 'onsite')`,
      );

      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r.posting_id).sort();
      expect(ids).toEqual(['ramp-1', 'ramp-3']);
    });
  });

  describe('month navigation', () => {
    it('events for specific month filtered correctly', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'stripe-1', { data: { company: 'Stripe', company_slug: 'stripe' } });
      await createApplication(db, 'ramp-1', 'applied', {
        applied_at: '2026-08-15T10:00:00Z',
        deadline: '2026-09-01',
      });
      await createApplication(db, 'stripe-1', 'applied', {
        applied_at: '2026-09-01T10:00:00Z',
        deadline: '2026-10-15',
      });

      const augustDeadlines = await db.query<{ posting_id: string; deadline: string }>(
        `SELECT a.posting_id, a.deadline FROM applications a
         WHERE a.deadline IS NOT NULL AND a.deadline >= '2026-08-01' AND a.deadline < '2026-09-01'`,
      );
      expect(augustDeadlines).toHaveLength(0);

      const septemberDeadlines = await db.query<{ posting_id: string; deadline: string }>(
        `SELECT a.posting_id, a.deadline FROM applications a
         WHERE a.deadline IS NOT NULL AND a.deadline >= '2026-09-01' AND a.deadline < '2026-10-01'`,
      );
      expect(septemberDeadlines).toHaveLength(1);
      expect(septemberDeadlines[0]?.deadline).toBe('2026-09-01');
    });
  });
});
