import { CLASSIFICATION_VERSION } from './role-taxonomy';
import { refreshJobDetails } from '@/details/cache';
import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import type { ClassificationResult, EligibilityVerdict } from './types';
import { normalizeCategoryValue, parseCategoryTags } from './types';
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

// A cancellation probe: returns true once this run has been superseded by a
// newer one (e.g. the user changed preferences again). Checked between chunks so
// a stale calculation stops instead of overwriting fresher results.
export type Cancelled = () => boolean;

// Rows processed per batch before yielding the main thread. Large enough to keep
// database round-trips cheap, small enough that classification never blocks the
// UI for long.
const RECOMPUTE_CHUNK = 250;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// Recomputes run one at a time. The chunked loop yields to the UI mid-run, so
// without this two overlapping recomputes could interleave their batched writes
// and leave a row scored against one profile but classified against another.
// Serialising preserves the previous "the last full run wins" guarantee.
let recomputeTail: Promise<unknown> = Promise.resolve();
function serializeRecompute<T>(task: () => Promise<T>): Promise<T> {
  const run = recomputeTail.then(task, task);
  recomputeTail = run.then(() => undefined, () => undefined);
  return run;
}

async function storeResult(
  db: Database,
  postingId: string,
  result: RecomputeResult,
): Promise<void> {
  await db.run(
    `UPDATE postings_cache
     SET category = ?, category_tags = ?, role_classification = ?, classification_version = ?, term = ?, eligibility = ?, score = ?, score_breakdown = ?
     WHERE id = ?`,
    [
      result.classification.category.category,
      JSON.stringify(result.classification.category.category_tags),
      JSON.stringify(result.classification.category),
      result.classification.category.version,
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
      category_tags: classification.category.category_tags,
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
  cancelled?: Cancelled,
): Promise<Map<string, RecomputeResult>> {
  return serializeRecompute(async () => {
    const results = new Map<string, RecomputeResult>();
    if (postingIds.length === 0 || cancelled?.()) return results;

    const requestedIds = new Set(postingIds);
    const rows = await db.query<{
      id: string;
      data: string;
      description: string | null;
      first_seen_at: string | null;
    }>(
      'SELECT id, data, description, first_seen_at FROM postings_cache',
    );

    // Classification (regex + description extraction) is the CPU cost here. It is
    // processed in bounded chunks that write and then yield to the UI, so a full
    // reclassification of the feed never blocks the main thread in one stretch.
    let statements: Parameters<Database['batch']>[0] = [];
    const flush = async (): Promise<void> => {
      if (statements.length === 0) return;
      await db.batch(statements);
      statements = [];
    };

    for (const row of rows) {
      if (!requestedIds.has(row.id)) continue;
      const posting = parsePosting(row.data);
      if (!posting) continue;

      const classification = classifyPosting(posting, row.description, profile);
      const firstSeenAt = row.first_seen_at ?? posting.first_seen_at;
      const score = scorePosting(
        {
          company_slug: posting.company_slug,
          first_seen_at: firstSeenAt,
          eligibility_verdict: classification.eligibility.verdict,
          category: classification.category.category,
          category_tags: classification.category.category_tags,
        },
        profile,
        now,
      );
      const result: RecomputeResult = { classification, score };
      results.set(row.id, result);
      statements.push({
        sql: `UPDATE postings_cache
              SET category = ?, category_tags = ?, role_classification = ?, classification_version = ?, term = ?, eligibility = ?, score = ?, score_breakdown = ?
              WHERE id = ?`,
        params: [
          classification.category.category,
          JSON.stringify(classification.category.category_tags),
          JSON.stringify(classification.category),
          classification.category.version,
          classification.term.term,
          JSON.stringify(classification.eligibility),
          score.score,
          JSON.stringify(score.breakdown),
          row.id,
        ],
      });

      if (statements.length >= RECOMPUTE_CHUNK) {
        await flush();
        if (cancelled?.()) return results;
        await yieldToMain();
        if (cancelled?.()) return results;
      }
    }

    await flush();
    return results;
  });
}

export async function recomputeAll(
  db: Database,
  profile: Profile,
  now?: Date,
  cancelled?: Cancelled,
): Promise<number> {
  await refreshJobDetails(db, profile);
  if (cancelled?.()) return 0;
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM postings_cache WHERE closed_at IS NULL',
  );

  const results = await recomputeNewPostings(db, rows.map((r) => r.id), profile, now, cancelled);
  return results.size;
}

export async function recomputePendingCategoryTaxonomy(
  db: Database,
  profile: Profile,
  now?: Date,
  cancelled?: Cancelled,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM postings_cache
     WHERE category_tags IS NULL OR category IS NULL OR score IS NULL
       OR role_classification IS NULL
       OR classification_version IS NULL OR classification_version != ?`,
    [CLASSIFICATION_VERSION],
  );
  if (rows.length === 0) return 0;

  const results = await recomputeNewPostings(
    db,
    rows.map((row) => row.id),
    profile,
    now,
    cancelled,
  );
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
    category_tags: string | null;
    eligibility: string | null;
  }>(
    'SELECT data, first_seen_at, category, category_tags, eligibility FROM postings_cache WHERE id = ?',
    [postingId],
  );

  if (!row) return null;

  const posting = parsePosting(row.data);
  if (!posting) return null;

  const categoryTags = parseCategoryTags(row.category_tags, row.category);
  const category = normalizeCategoryValue(row.category) ?? categoryTags[0] ?? 'other';

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
      category_tags: categoryTags,
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
