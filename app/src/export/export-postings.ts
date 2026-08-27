import type { Database } from '@/db/types';

export interface PostingExportRow {
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  source: string;
  category: string | null;
  term: string | null;
  eligibility_verdict: string | null;
  score: number | null;
  description: string | null;
  first_seen_at: string | null;
  closed_at: string | null;
  synced_at: string;
}

export interface PostingsExport {
  exported_at: string;
  count: number;
  version: string;
  postings: PostingExportRow[];
}

export async function exportPostingsJSON(db: Database): Promise<string> {
  const rows = await db.query<{
    id: string;
    data: string;
    category: string | null;
    term: string | null;
    eligibility: string | null;
    score: number | null;
    description: string | null;
    first_seen_at: string | null;
    closed_at: string | null;
    synced_at: string;
  }>(
    `SELECT id, data, category, term, eligibility, score,
            description, first_seen_at, closed_at, synced_at
     FROM postings_cache
     ORDER BY score DESC NULLS LAST, first_seen_at DESC`,
  );

  const postings: PostingExportRow[] = rows.map((row) => {
    const posting = JSON.parse(row.data) as {
      company?: string;
      title?: string;
      location?: string;
      url?: string;
      source?: string;
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
      id: row.id,
      company: posting.company ?? '',
      title: posting.title ?? '',
      location: posting.location ?? '',
      url: posting.url ?? '',
      source: posting.source ?? '',
      category: row.category,
      term: row.term,
      eligibility_verdict: verdict,
      score: row.score,
      description: row.description,
      first_seen_at: row.first_seen_at,
      closed_at: row.closed_at,
      synced_at: row.synced_at,
    };
  });

  const output: PostingsExport = {
    exported_at: new Date().toISOString(),
    count: postings.length,
    version: '0.1.0',
    postings,
  };

  return JSON.stringify(output, null, 2);
}
