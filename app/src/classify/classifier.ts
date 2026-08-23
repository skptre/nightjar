import type { NightjarDB } from '@/db/database';
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

export function classifyAndStore(
  db: NightjarDB,
  postingId: string,
  profile: Profile,
): ClassificationResult | null {
  const row = db.queryOne<{ data: string; description: string | null }>(
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

  db.run(
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

export function classifyNewPostings(
  db: NightjarDB,
  postingIds: string[],
  profile: Profile,
): Map<string, ClassificationResult> {
  const results = new Map<string, ClassificationResult>();

  db.transaction(() => {
    for (const id of postingIds) {
      const result = classifyAndStoreInTransaction(db, id, profile);
      if (result) {
        results.set(id, result);
      }
    }
  });

  return results;
}

function classifyAndStoreInTransaction(
  db: NightjarDB,
  postingId: string,
  profile: Profile,
): ClassificationResult | null {
  const row = db.queryOne<{ data: string; description: string | null }>(
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

  db.run(
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

export function reclassifyAll(
  db: NightjarDB,
  profile: Profile,
): number {
  const rows = db.query<{ id: string }>(
    'SELECT id FROM postings_cache WHERE closed_at IS NULL',
  );

  const results = classifyNewPostings(db, rows.map((r) => r.id), profile);
  return results.size;
}
