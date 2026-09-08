import type { Database } from '@/db/database';
import type { FeedPosting } from '@/sync/feed-sync';
import { CLASSIFICATION_VERSION } from './role-taxonomy';
import { classifyCategory } from './category-classifier';
import { classifyTerm } from './term-classifier';
export async function recomputeGuestCategories(db: Database): Promise<number> {
  const rows = await db.query<{ id: string; data: string; description: string | null }>(
    'SELECT id,data,description FROM postings_cache WHERE classification_version IS NULL OR classification_version != ?', [CLASSIFICATION_VERSION]);
  const statements: Parameters<Database['batch']>[0] = [];
  for (const row of rows) {
    let posting: FeedPosting;
    try { posting = JSON.parse(row.data) as FeedPosting; if (typeof posting.title !== 'string') continue; } catch { continue; }
    const context = { ...posting.source_metadata, company: posting.company };
    if (posting.department?.trim()) context.department = posting.department.trim();
    const category = classifyCategory(posting.title, row.description, posting.source_metadata?.category, context);
    const term = classifyTerm(posting.title, row.description, posting.posted_at);
    statements.push({ sql: `UPDATE postings_cache SET category=?,category_tags=?,role_classification=?,classification_version=?,term=? WHERE id=?`,
      params: [category.category, JSON.stringify(category.category_tags), JSON.stringify(category), category.version, term.term, row.id] });
  }
  await db.batch(statements);
  return statements.length;
}
