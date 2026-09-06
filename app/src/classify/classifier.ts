import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { ClassificationResult, EligibilityResult } from './types';
import type { FeedPosting } from '@/sync/feed-sync';
import { classifyTerm } from './term-classifier';
import { classifyCategory } from './category-classifier';
import { extractJobDetails } from '@/details/extract';
import { assessRequirements } from '@/details/requirements';
import { acquisitionStatus } from '@/details/cache';

export function classifyPosting(
  posting: FeedPosting,
  description: string | null,
  profile: Profile,
): ClassificationResult {
  const term = classifyTerm(posting.title, description, posting.posted_at);
  const context = { ...posting.source_metadata };
  if (posting.department?.trim()) context.department = posting.department.trim();
  const category = classifyCategory(
    posting.title,
    description,
    posting.source_metadata?.category,
    context,
  );
  const assessment = assessRequirements(extractJobDetails(description, {
    acquisition: acquisitionStatus(posting.description_status),
  }), profile);
  // Compatibility storage for scoring/notifications; kept jobs carry no eligibility claim.
  // Graduation affects ordering separately and never becomes an authorization exclusion.
  const eligibility: EligibilityResult = {
    verdict: assessment.exclude ? 'ineligible' : 'unclear',
    reasons: assessment.exclusionEvidence.map(e => e.text),
    flags: assessment.exclusionEvidence.map(e => ({ type: 'explicit_authorization_conflict',
      matched_sentence: e.text, pattern: 'verified_description_requirement' })),
  };

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
     SET category = ?, category_tags = ?, role_classification = ?, classification_version = ?, term = ?, eligibility = ?
     WHERE id = ?`,
    [
      result.category.category,
      JSON.stringify(result.category.category_tags),
      JSON.stringify(result.category),
      result.category.version,
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
  if (postingIds.length === 0) return results;

  const requestedIds = new Set(postingIds);
  const rows = await db.query<{ id: string; data: string; description: string | null }>(
    'SELECT id, data, description FROM postings_cache',
  );
  const statements: Parameters<Database['batch']>[0] = [];

  for (const row of rows) {
    if (!requestedIds.has(row.id)) continue;
    let posting: FeedPosting;
    try {
      posting = JSON.parse(row.data) as FeedPosting;
    } catch {
      continue;
    }

    const result = classifyPosting(posting, row.description, profile);
    results.set(row.id, result);
    statements.push({
      sql: `UPDATE postings_cache
            SET category = ?, category_tags = ?, role_classification = ?, classification_version = ?, term = ?, eligibility = ?
            WHERE id = ?`,
      params: [
        result.category.category,
        JSON.stringify(result.category.category_tags),
        JSON.stringify(result.category),
        result.category.version,
        result.term.term,
        JSON.stringify(result.eligibility),
        row.id,
      ],
    });
  }

  await db.batch(statements);

  return results;
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
