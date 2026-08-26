import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import type { ClassificationResult, CategoryValue, EligibilityVerdict } from './types';
import { classifyPosting } from './classifier';
import { scorePosting, type ScoreResult } from './scoring';

export interface RecomputeResult {
  classification: ClassificationResult;
  score: ScoreResult;
}

function parsePosting(data: string): FeedPosting | null {
  try {
    return JSON.parse(data) as FeedPosting;
  } catch {
    return null;
  }
}

async function storeResult(
  db: Database,
  postingId: string,
  result: RecomputeResult,
): Promise<void> {
  await db.run(
    `UPDATE postings_cache
     SET category = ?, term = ?, eligibility = ?, score = ?, score_breakdown = ?
     WHERE id = ?`,
    [
      result.classification.category.category,
      result.classification.term.term,
      JSON.stringify(result.classification.eligibility),
      result.score.score,
      JSON.stringify(result.score.breakdown),
      postingId,
    ],
  );
}

export async function recomputePosting(
  db: Database,
  postingId: string,
  profile: Profile,
  now?: Date,
): Promise<RecomputeResult | null> {
  const row = await db.queryOne<{ data: string; description: string | null; first_seen_at: string | null }>(
    'SELECT data, description, first_seen_at FROM postings_cache WHERE id = ?',
    [postingId],
  );

  if (!row) return null;

  const posting = parsePosting(row.data);
  if (!posting) return null;

  const classification = classifyPosting(posting, row.description, profile);

  const firstSeenAt = row.first_seen_at ?? posting.first_seen_at;

  const score = scorePosting(
    {
      company_slug: posting.company_slug,
      first_seen_at: firstSeenAt,
      eligibility_verdict: classification.eligibility.verdict,
      category: classification.category.category,
    },
    profile,
    now,
  );

  const result: RecomputeResult = { classification, score };
  await storeResult(db, postingId, result);

  return result;
}

export async function recomputeNewPostings(
  db: Database,
  postingIds: string[],
  profile: Profile,
  now?: Date,
): Promise<Map<string, RecomputeResult>> {
  const results = new Map<string, RecomputeResult>();

  await db.transaction(async () => {
    for (const id of postingIds) {
      const result = await recomputePostingInTransaction(db, id, profile, now);
      if (result) {
        results.set(id, result);
      }
    }
  });

  return results;
}

export async function recomputeAll(
  db: Database,
  profile: Profile,
  now?: Date,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM postings_cache WHERE closed_at IS NULL',
  );

  const results = await recomputeNewPostings(db, rows.map((r) => r.id), profile, now);
  return results.size;
}

export async function rescorePosting(
  db: Database,
  postingId: string,
  profile: Profile,
  now?: Date,
): Promise<ScoreResult | null> {
  const row = await db.queryOne<{
    data: string;
    first_seen_at: string | null;
    category: string | null;
    eligibility: string | null;
  }>(
    'SELECT data, first_seen_at, category, eligibility FROM postings_cache WHERE id = ?',
    [postingId],
  );

  if (!row) return null;

  const posting = parsePosting(row.data);
  if (!posting) return null;

  const category = (row.category ?? 'other') as CategoryValue;

  let eligibilityVerdict: EligibilityVerdict = 'unclear';
  if (row.eligibility) {
    try {
      const parsed = JSON.parse(row.eligibility) as { verdict?: string };
      if (parsed.verdict === 'eligible' || parsed.verdict === 'ineligible' || parsed.verdict === 'unclear') {
        eligibilityVerdict = parsed.verdict;
      }
    } catch {
      // keep 'unclear'
    }
  }

  const firstSeenAt = row.first_seen_at ?? posting.first_seen_at;

  const score = scorePosting(
    {
      company_slug: posting.company_slug,
      first_seen_at: firstSeenAt,
      eligibility_verdict: eligibilityVerdict,
      category,
    },
    profile,
    now,
  );

  await db.run(
    'UPDATE postings_cache SET score = ?, score_breakdown = ? WHERE id = ?',
    [score.score, JSON.stringify(score.breakdown), postingId],
  );

  return score;
}

async function recomputePostingInTransaction(
  db: Database,
  postingId: string,
  profile: Profile,
  now?: Date,
): Promise<RecomputeResult | null> {
  const row = await db.queryOne<{ data: string; description: string | null; first_seen_at: string | null }>(
    'SELECT data, description, first_seen_at FROM postings_cache WHERE id = ?',
    [postingId],
  );

  if (!row) return null;

  const posting = parsePosting(row.data);
  if (!posting) return null;

  const classification = classifyPosting(posting, row.description, profile);

  const firstSeenAt = row.first_seen_at ?? posting.first_seen_at;

  const score = scorePosting(
    {
      company_slug: posting.company_slug,
      first_seen_at: firstSeenAt,
      eligibility_verdict: classification.eligibility.verdict,
      category: classification.category.category,
    },
    profile,
    now,
  );

  const result: RecomputeResult = { classification, score };

  await db.run(
    `UPDATE postings_cache
     SET category = ?, term = ?, eligibility = ?, score = ?, score_breakdown = ?
     WHERE id = ?`,
    [
      result.classification.category.category,
      result.classification.term.term,
      JSON.stringify(result.classification.eligibility),
      result.score.score,
      JSON.stringify(result.score.breakdown),
      postingId,
    ],
  );

  return result;
}
