import { describe, it, expect, beforeEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import { exportApplicationsCSV, queryApplicationRows } from './export-csv';
import { exportApplicationsJSON } from './export-json';
import { exportPostingsJSON } from './export-postings';

describe('export', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  async function insertPosting(
    id: string,
    data: Record<string, unknown>,
    extras: {
      category?: string;
      eligibility?: string;
      score?: number;
      description?: string;
    } = {},
  ): Promise<void> {
    const now = '2026-08-15T00:00:00Z';
    await db.run(
      `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, category, eligibility, score, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        JSON.stringify(data),
        '2026-08-01T00:00:00Z',
        now,
        extras.category ?? null,
        extras.eligibility ?? null,
        extras.score ?? null,
        extras.description ?? null,
      ],
    );
  }

  async function insertApplication(
    postingId: string,
    status: string,
    extras: {
      applied_at?: string;
      deadline?: string;
      notes?: string;
      next_action?: string;
      next_action_at?: string;
    } = {},
  ): Promise<void> {
    const now = '2026-08-15T00:00:00Z';
    await db.run(
      `INSERT INTO applications (posting_id, status, applied_at, deadline, notes, next_action, next_action_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        postingId,
        status,
        extras.applied_at ?? null,
        extras.deadline ?? null,
        extras.notes ?? null,
        extras.next_action ?? null,
        extras.next_action_at ?? null,
        now,
        now,
      ],
    );
  }

  describe('CSV export', () => {
    it('produces header-only CSV for empty applications', async () => {
      const csv = await exportApplicationsCSV(db);
      const lines = csv.split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        'company,title,status,applied_at,deadline,location,url,category,eligibility_verdict,score,notes,next_action,next_action_at,created_at,updated_at',
      );
    });

    it('exports application rows with correct fields', async () => {
      await insertPosting('p1', {
        company: 'Ramp',
        title: 'SWE Intern',
        location: 'NYC',
        url: 'https://ramp.com/jobs/1',
      }, {
        category: 'swe',
        eligibility: '{"verdict":"eligible","reasons":[]}',
        score: 85.5,
      });
      await insertApplication('p1', 'applied', {
        applied_at: '2026-08-10T12:00:00Z',
      });

      const csv = await exportApplicationsCSV(db);
      const lines = csv.split('\n');
      expect(lines).toHaveLength(2);

      const row = lines[1]!;
      expect(row).toContain('Ramp');
      expect(row).toContain('SWE Intern');
      expect(row).toContain('applied');
      expect(row).toContain('2026-08-10');
      expect(row).toContain('NYC');
      expect(row).toContain('swe');
      expect(row).toContain('eligible');
      expect(row).toContain('85.5');
    });

    it('properly escapes commas in titles', async () => {
      await insertPosting('p2', {
        company: 'Stripe',
        title: 'Software Engineer, Backend',
        location: 'SF',
        url: 'https://stripe.com/jobs/2',
      });
      await insertApplication('p2', 'saved');

      const csv = await exportApplicationsCSV(db);
      const lines = csv.split('\n');
      expect(lines[1]).toContain('"Software Engineer, Backend"');
    });

    it('properly escapes quotes in notes', async () => {
      await insertPosting('p3', {
        company: 'Figma',
        title: 'Designer',
        location: 'Remote',
        url: 'https://figma.com/jobs/3',
      });
      await insertApplication('p3', 'saved', {
        notes: 'She said "apply early"',
      });

      const csv = await exportApplicationsCSV(db);
      expect(csv).toContain('"She said ""apply early"""');
    });

    it('handles 5 applications with correct row count', async () => {
      for (let i = 1; i <= 5; i++) {
        await insertPosting(`p${i}`, {
          company: `Company${i}`,
          title: `Role${i}`,
          location: 'NYC',
          url: `https://example.com/${i}`,
        });
        await insertApplication(`p${i}`, 'applied');
      }

      const csv = await exportApplicationsCSV(db);
      const lines = csv.split('\n');
      expect(lines).toHaveLength(6);
    });

    it('formats dates as YYYY-MM-DD', async () => {
      await insertPosting('p4', {
        company: 'Linear',
        title: 'Eng',
        location: 'Remote',
        url: 'https://linear.app/jobs/4',
      });
      await insertApplication('p4', 'applied', {
        applied_at: '2026-08-15T14:30:00Z',
        deadline: '2026-09-01T00:00:00Z',
      });

      const rows = await queryApplicationRows(db);
      expect(rows[0]!.applied_at).toBe('2026-08-15');
      expect(rows[0]!.deadline).toBe('2026-09-01');
    });

    it('handles null eligibility gracefully', async () => {
      await insertPosting('p5', {
        company: 'Neon',
        title: 'Intern',
        location: 'Remote',
        url: 'https://neon.tech/jobs/5',
      });
      await insertApplication('p5', 'new');

      const rows = await queryApplicationRows(db);
      expect(rows[0]!.eligibility_verdict).toBeNull();
    });
  });

  describe('JSON export', () => {
    it('produces valid JSON with metadata', async () => {
      await insertPosting('p1', {
        company: 'Ramp',
        title: 'SWE Intern',
        location: 'NYC',
        url: 'https://ramp.com/jobs/1',
      });
      await insertApplication('p1', 'applied');

      const json = await exportApplicationsJSON(db);
      const parsed = JSON.parse(json) as {
        exported_at: string;
        count: number;
        version: string;
        applications: unknown[];
      };

      expect(parsed.count).toBe(1);
      expect(parsed.version).toBe('0.1.0');
      expect(parsed.exported_at).toBeTruthy();
      expect(parsed.applications).toHaveLength(1);
    });

    it('returns empty applications array when none exist', async () => {
      const json = await exportApplicationsJSON(db);
      const parsed = JSON.parse(json) as { count: number; applications: unknown[] };
      expect(parsed.count).toBe(0);
      expect(parsed.applications).toHaveLength(0);
    });

    it('preserves all fields from application row', async () => {
      await insertPosting('p1', {
        company: 'Anthropic',
        title: 'ML Intern',
        location: 'SF',
        url: 'https://anthropic.com/jobs/1',
      }, {
        category: 'ml',
        eligibility: '{"verdict":"unclear"}',
        score: 72.0,
      });
      await insertApplication('p1', 'applied', {
        applied_at: '2026-08-12T00:00:00Z',
        notes: 'Reached out to recruiter',
        next_action: 'Follow up',
        next_action_at: '2026-08-20T00:00:00Z',
      });

      const json = await exportApplicationsJSON(db);
      const parsed = JSON.parse(json) as {
        applications: Array<{
          company: string;
          title: string;
          category: string | null;
          eligibility_verdict: string | null;
          score: number | null;
          notes: string | null;
          next_action: string | null;
        }>;
      };

      const app = parsed.applications[0]!;
      expect(app.company).toBe('Anthropic');
      expect(app.title).toBe('ML Intern');
      expect(app.category).toBe('ml');
      expect(app.eligibility_verdict).toBe('unclear');
      expect(app.score).toBe(72.0);
      expect(app.notes).toBe('Reached out to recruiter');
      expect(app.next_action).toBe('Follow up');
    });
  });

  describe('postings export', () => {
    it('exports all postings with metadata', async () => {
      await insertPosting('p1', {
        company: 'Ramp',
        title: 'SWE Intern',
        location: 'NYC',
        url: 'https://ramp.com/jobs/1',
        source: 'greenhouse',
      }, {
        category: 'swe',
        score: 90,
        description: 'Full stack role',
      });

      await insertPosting('p2', {
        company: 'Linear',
        title: 'Backend Eng',
        location: 'Remote',
        url: 'https://linear.app/jobs/2',
        source: 'ashby',
      }, {
        category: 'swe',
        score: 60,
      });

      const json = await exportPostingsJSON(db);
      const parsed = JSON.parse(json) as {
        count: number;
        version: string;
        postings: Array<{
          id: string;
          company: string;
          source: string;
          description: string | null;
        }>;
      };

      expect(parsed.count).toBe(2);
      expect(parsed.version).toBe('0.1.0');
      expect(parsed.postings[0]!.id).toBe('p1');
      expect(parsed.postings[0]!.description).toBe('Full stack role');
      expect(parsed.postings[1]!.description).toBeNull();
    });

    it('exports empty array when no postings exist', async () => {
      const json = await exportPostingsJSON(db);
      const parsed = JSON.parse(json) as { count: number; postings: unknown[] };
      expect(parsed.count).toBe(0);
      expect(parsed.postings).toHaveLength(0);
    });

    it('orders by score descending', async () => {
      await insertPosting('low', {
        company: 'A',
        title: 'Low',
        location: '',
        url: '',
      }, { score: 20 });

      await insertPosting('high', {
        company: 'B',
        title: 'High',
        location: '',
        url: '',
      }, { score: 95 });

      const json = await exportPostingsJSON(db);
      const parsed = JSON.parse(json) as {
        postings: Array<{ id: string; score: number | null }>;
      };
      expect(parsed.postings[0]!.id).toBe('high');
      expect(parsed.postings[1]!.id).toBe('low');
    });
  });
});
