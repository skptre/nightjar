import type { Database } from '@/db/database';
import type { FeedPosting } from '@/sync/feed-sync';
import { CLASSIFICATION_VERSION } from './role-taxonomy';
import { classifyCategory } from './category-classifier';
import { classifyTerm } from './term-classifier';
import { isTauri } from '@/lib/platform';
import { createUIYield, yieldToUI } from '@/lib/background';
export async function recomputeGuestCategories(db: Database): Promise<number> {
  const pending = await db.query<{ id: string }>(
    'SELECT id FROM postings_cache WHERE classification_version IS NULL OR classification_version != ?', [CLASSIFICATION_VERSION]);
  let statements: Parameters<Database['batch']>[0] = [];
  let changed = 0;
  const checkpoint = createUIYield();
  for (let offset = 0; offset < pending.length; offset += 25) {
    const ids = pending.slice(offset, offset + 25).map(row => row.id);
    const rows = await db.query<{ id: string; data: string; description: string | null }>(
      `SELECT id,data,description FROM postings_cache WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const row of rows) {
      let posting: FeedPosting;
      try { posting = JSON.parse(row.data) as FeedPosting; if (typeof posting.title !== 'string') continue; } catch { continue; }
      const context = { ...posting.source_metadata, company: posting.company };
      if (posting.department?.trim()) context.department = posting.department.trim();
      const category = classifyCategory(posting.title, row.description, posting.source_metadata?.category, context);
      const term = classifyTerm(posting.title, row.description, posting.posted_at);
      statements.push({ sql: `UPDATE postings_cache SET category=?,category_tags=?,role_classification=?,classification_version=?,term=? WHERE id=?`,
        params: [category.category, JSON.stringify(category.category_tags), JSON.stringify(category), category.version, term.term, row.id] });
      changed++;
      await checkpoint();
    }
    if (isTauri()) { await db.batch(statements); statements = []; }
    await yieldToUI();
  }
  await db.batch(statements);
  return changed;
}
