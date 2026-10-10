import type { Database } from '@/db/database';
import { isTauri } from '@/lib/platform';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import type { AcquisitionStatus, JobDetails, RequirementAssessment } from './types';
import { DETAILS_VERSION, extractJobDetails } from './extract';
import { assessRequirements } from './requirements';

export interface CachedJobDetails { details: JobDetails; assessment: RequirementAssessment | null }

export function acquisitionStatus(value: unknown): AcquisitionStatus {
  return ['available', 'stale', 'partial', 'unavailable', 'unsupported'].includes(String(value))
    ? value as AcquisitionStatus : 'unknown';
}

export async function refreshJobDetails(db: Database, profile: Profile | null): Promise<number> {
  const rows = await db.query<{ id: string; data: string; description: string | null;
    details_json: string | null; context_key: string | null }>(
    `SELECT p.id, p.data, p.description, d.details_json, d.context_key
     FROM postings_cache p LEFT JOIN job_details_cache d ON d.posting_id = p.id`);
  const statements: Parameters<Database['batch']>[0] = [];
  for (const row of rows) {
    let posting: FeedPosting;
    try { posting = JSON.parse(row.data) as FeedPosting; } catch { continue; }
    const acquisition = acquisitionStatus(posting.description_status);
    const source = posting.source_metadata?.source_compensation;
    const contextKey = JSON.stringify([DETAILS_VERSION, acquisition, source, posting.compensation,
      profile?.graduation, profile?.work_auth, profile?.authorization_path]);
    if (row.context_key === contextKey && row.details_json) {
      try {
        const cached = JSON.parse(row.details_json) as JobDetails;
        if (cached.version === DETAILS_VERSION && cached.document === (row.description ?? '')) continue;
      } catch { /* Repair malformed cached data from original source. */ }
    }
    const details = extractJobDetails(row.description, { acquisition, structuredCompensation: source,
      ...(posting.compensation ? { advertisedCompensation: posting.compensation } : {}) });
    const assessment = profile ? assessRequirements(details, profile) : null;
    statements.push({ sql: `INSERT INTO job_details_cache (posting_id, context_key, details_json, assessment_json)
      VALUES (?, ?, ?, ?) ON CONFLICT(posting_id) DO UPDATE SET context_key=excluded.context_key,
      details_json=excluded.details_json, assessment_json=excluded.assessment_json`,
      params: [row.id, contextKey, JSON.stringify(details), JSON.stringify(assessment)] });
    statements.push({ sql: `UPDATE postings_cache SET eligibility = NULL, score = NULL,
      classification_version = NULL WHERE id = ?`, params: [row.id] });
  }
  if (isTauri()) {
    for (let index = 0; index < statements.length; index += 250) {
      await db.batch(statements.slice(index, index + 250));
    }
  } else {
    await db.batch(statements);
  }
  return statements.length / 2;
}

export async function getJobDetails(db: Database, id: string): Promise<CachedJobDetails | null> {
  const row = await db.queryOne<{ details_json: string; assessment_json: string }>(
    'SELECT details_json, assessment_json FROM job_details_cache WHERE posting_id = ?', [id]);
  if (!row) return null;
  try { return { details: JSON.parse(row.details_json) as JobDetails,
    assessment: JSON.parse(row.assessment_json) as RequirementAssessment | null }; } catch { return null; }
}
