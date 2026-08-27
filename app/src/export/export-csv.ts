import type { Database } from '@/db/types';

export interface ApplicationRow {
  company: string;
  title: string;
  status: string;
  applied_at: string | null;
  deadline: string | null;
  location: string;
  url: string;
  category: string | null;
  eligibility_verdict: string | null;
  score: number | null;
  notes: string | null;
  next_action: string | null;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

const CSV_COLUMNS: (keyof ApplicationRow)[] = [
  'company',
  'title',
  'status',
  'applied_at',
  'deadline',
  'location',
  'url',
  'category',
  'eligibility_verdict',
  'score',
  'notes',
  'next_action',
  'next_action_at',
  'created_at',
  'updated_at',
];

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1]! : iso;
}

export async function queryApplicationRows(db: Database): Promise<ApplicationRow[]> {
  const rows = await db.query<{
    data: string;
    status: string;
    applied_at: string | null;
    deadline: string | null;
    category: string | null;
    eligibility: string | null;
    score: number | null;
    notes: string | null;
    next_action: string | null;
    next_action_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT p.data, a.status, a.applied_at, a.deadline,
            p.category, p.eligibility, p.score,
            a.notes, a.next_action, a.next_action_at,
            a.created_at, a.updated_at
     FROM applications a
     JOIN postings_cache p ON p.id = a.posting_id
     ORDER BY a.updated_at DESC`,
  );

  return rows.map((row) => {
    const posting = JSON.parse(row.data) as {
      company?: string;
      title?: string;
      location?: string;
      url?: string;
    };

    let verdict: string | null = null;
    if (row.eligibility) {
      try {
        const parsed = JSON.parse(row.eligibility) as { verdict?: string };
        verdict = parsed.verdict ?? null;
      } catch {
        verdict = null;
      }
    }

    return {
      company: posting.company ?? '',
      title: posting.title ?? '',
      status: row.status,
      applied_at: formatDate(row.applied_at),
      deadline: formatDate(row.deadline),
      location: posting.location ?? '',
      url: posting.url ?? '',
      category: row.category,
      eligibility_verdict: verdict,
      score: row.score,
      notes: row.notes,
      next_action: row.next_action,
      next_action_at: formatDate(row.next_action_at),
      created_at: formatDate(row.created_at),
      updated_at: formatDate(row.updated_at),
    };
  });
}

export async function exportApplicationsCSV(db: Database): Promise<string> {
  const rows = await queryApplicationRows(db);
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => escapeCSV(row[col])).join(','),
  );
  return [header, ...lines].join('\n');
}
