import type { Database } from '@/db/database';
import { isTauri } from '@/lib/platform';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import type { AcquisitionStatus, JobDetails, RequirementAssessment } from './types';
import { DETAILS_VERSION, extractJobDetails } from './extract';
import { assessRequirements } from './requirements';
import { createUIYield, yieldToUI } from '@/lib/background';

export interface CachedJobDetails { details: JobDetails; assessment: RequirementAssessment | null }

export function acquisitionStatus(value: unknown): AcquisitionStatus {
  return ['available', 'stale', 'partial', 'unavailable', 'unsupported'].includes(String(value))
    ? value as AcquisitionStatus : 'unknown';
}

export async function refreshJobDetails(db: Database, profile: Profile | null): Promise<number> {
  // Compare inputs in SQLite. A warm launch transfers only pending IDs, never
  // thousands of unchanged documents through the native WebView bridge.
  const pending = await db.query<{ id: string }>(`SELECT p.id
    FROM postings_cache p LEFT JOIN job_details_cache d ON d.posting_id = p.id
    WHERE json_valid(p.data) AND (d.posting_id IS NULL OR NOT json_valid(d.details_json)
      OR d.context_key != json_array(?,
        CASE WHEN json_extract(p.data, '$.description_status') IN ('available','stale','partial','unavailable','unsupported')
          THEN json_extract(p.data, '$.description_status') ELSE 'unknown' END,
        json_extract(p.data, '$.source_metadata.source_compensation'), json_extract(p.data, '$.compensation'), ?, ?, ?)
      OR CASE WHEN json_valid(d.details_json) THEN
        json_extract(d.details_json, '$.version') IS NOT ?
        OR json_extract(d.details_json, '$.document') IS NOT COALESCE(p.description, '') ELSE 1 END)`,
    [DETAILS_VERSION, profile?.graduation ?? null, profile?.work_auth ?? null,
      profile?.authorization_path ?? null, DETAILS_VERSION]);
  let statements: Parameters<Database['batch']>[0] = [];
  let changed = 0;
  const checkpoint = createUIYield();
  for (let offset = 0; offset < pending.length; offset += 25) {
    const ids = pending.slice(offset, offset + 25).map(row => row.id);
    const rows = await db.query<{ id: string; data: string; description: string | null }>(
      `SELECT id, json_remove(data, '$.description_text') AS data, description FROM postings_cache
       WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const row of rows) {
      let posting: FeedPosting;
      try { posting = JSON.parse(row.data) as FeedPosting; } catch { continue; }
      const acquisition = acquisitionStatus(posting.description_status);
      const source = posting.source_metadata?.source_compensation;
      const contextKey = JSON.stringify([DETAILS_VERSION, acquisition, source, posting.compensation,
        profile?.graduation, profile?.work_auth, profile?.authorization_path]);
      const details = extractJobDetails(row.description, { acquisition, structuredCompensation: source,
        ...(posting.compensation ? { advertisedCompensation: posting.compensation } : {}) });
      const assessment = profile ? assessRequirements(details, profile) : null;
      statements.push({ sql: `INSERT INTO job_details_cache (posting_id, context_key, details_json, assessment_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(posting_id) DO UPDATE SET context_key=excluded.context_key,
        details_json=excluded.details_json, assessment_json=excluded.assessment_json`,
        params: [row.id, contextKey, JSON.stringify(details), JSON.stringify(assessment)] });
      statements.push({ sql: `UPDATE postings_cache SET eligibility = NULL, score = NULL,
        classification_version = NULL WHERE id = ?`, params: [row.id] });
      changed++;
      await checkpoint();
    }
    if (isTauri()) {
      await db.batch(statements);
      statements = [];
    }
    await yieldToUI();
  }
  // Browser SQLite persists a snapshot per write: commit once, after CPU work
  // has yielded between chunks, rather than serializing the DB hundreds of times.
  await db.batch(statements);
  return changed;
}

export async function getJobDetails(db: Database, id: string): Promise<CachedJobDetails | null> {
  const row = await db.queryOne<{ details_json: string; assessment_json: string }>(
    'SELECT details_json, assessment_json FROM job_details_cache WHERE posting_id = ?', [id]);
  if (!row) return null;
  try { return { details: JSON.parse(row.details_json) as JobDetails,
    assessment: JSON.parse(row.assessment_json) as RequirementAssessment | null }; } catch { return null; }
}
