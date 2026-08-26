import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { ClassificationResult } from './types';
import type { FeedPosting } from '@/sync/feed-sync';
import { classifyTerm } from './term-classifier';
import { classifyCategory } from './category-classifier';
import { checkEligibility } from './eligibility';

export function classifyPosting(
  posting: FeedPosting,
  description: string | null,
  profile: Profile,
): ClassificationResult {
  const term = classifyTerm(posting.title, description, posting.posted_at);
  const category = classifyCategory(
    posting.title,
    description,
    posting.source_metadata?.category,
  );
  const eligibility = checkEligibility(
    posting.title,
    description,
    posting.locations ?? [],
    profile,
    posting.source_metadata,
  );

  return { term, category, eligibility };
}

export async function classifyAndStore(
  db: Database,
  postingId: string,
  profile: Profile,
): Promise<ClassificationResult | null> {
  const row = await db.queryOne<{ data: string; description: string | null }>(
    'SELECT data, description FROM postings_cache WHERE id = ?',
    [postingId],
  );

  if (!row) return null;

  let posting: FeedPosting;
  try {
    posting = JSON.parse(row.data) as FeedPosting;
  } catch {
    return null;
  }

  const result = classifyPosting(posting, row.description, profile);

  await db.run(
    `UPDATE postings_cache
     SET category = ?, term = ?, eligibility = ?
     WHERE id = ?`,
    [
      result.category.category,
      result.term.term,
      JSON.stringify(result.eligibility),
      postingId,
    ],
  );

  return result;
}

export async function classifyNewPostings(
  db: Database,
  postingIds: string[],
  profile: Profile,
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();

  await db.transaction(async () => {
    for (const id of postingIds) {
      const result = await classifyAndStoreInTransaction(db, id, profile);
      if (result) {
        results.set(id, result);
      }
    }
  });

  return results;
}

async function classifyAndStoreInTransaction(
  db: Database,
  postingId: string,
  profile: Profile,
): Promise<ClassificationResult | null> {
  const row = await db.queryOne<{ data: string; description: string | null }>(
    'SELECT data, description FROM postings_cache WHERE id = ?',
    [postingId],
  );

  if (!row) return null;

  let posting: FeedPosting;
  try {
    posting = JSON.parse(row.data) as FeedPosting;
  } catch {
    return null;
  }

  const result = classifyPosting(posting, row.description, profile);

  await db.run(
    `UPDATE postings_cache
     SET category = ?, term = ?, eligibility = ?
     WHERE id = ?`,
    [
      result.category.category,
      result.term.term,
      JSON.stringify(result.eligibility),
      postingId,
    ],
  );

  return result;
}

export async function reclassifyAll(
  db: Database,
  profile: Profile,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM postings_cache WHERE closed_at IS NULL',
  );

  const results = await classifyNewPostings(db, rows.map((r) => r.id), profile);
  return results.size;
}
