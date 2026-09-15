import type { Database, SqlValue } from '@/db/types';
import { validateAndRepairProfile } from '@/profile/profile-store';
import { isApplicationStatus } from '@/outcomes/types';

export const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
export const SETTINGS_KEYS = ['nightjar_profile', 'nightjar_theme', 'nightjar_density',
  'nightjar_watched_companies', 'nightjar_watch_alerts', 'nightjar_watch_alert_seen',
  'nightjar_alert_setup_dismissed', 'nightjar_onboarding_dismissed', 'nightjar_last_destination'] as const;
// Fixed identifiers only. Imported JSON never supplies SQL identifiers or SQL text.
const COLUMNS = {
  postings_cache: 'id data description first_seen_at closed_at category category_tags role_classification classification_version term eligibility score score_breakdown description_attempted_at description_error synced_at',
  applications: 'posting_id status applied_at deadline notes next_action next_action_at outcome outcome_at interview_rounds outcome_notes created_at updated_at',
  application_outcome_events: 'id posting_id outcome occurred_at interview_rounds notes',
  recalibration_suggestion_actions: 'suggestion_id status acted_at',
  companies_meta: 'slug name typical_open',
} as const;
type Table = keyof typeof COLUMNS;
type Row = Record<string, string | number | null>;
export interface WorkspaceBackup {
  format: 'nightjar-workspace'; version: 1; created_at: string;
  settings: Record<string, string>; tables: Record<Table, Row[]>;
}
const tables = Object.keys(COLUMNS) as Table[];
const primaryKeys: Record<Table, string> = { postings_cache: 'id', applications: 'posting_id',
  application_outcome_events: 'id', recalibration_suggestion_actions: 'suggestion_id', companies_meta: 'slug' };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new Error('This is not a valid, supported Nightjar workspace backup. Nothing was restored.'); }

export function readWorkspaceSettings(): Record<string, string> {
  return Object.fromEntries(SETTINGS_KEYS.flatMap(key => {
    const value = localStorage.getItem(key); return value === null ? [] : [[key, value]];
  }));
}
function validateSettings(value: unknown): asserts value is Record<string, string> {
  if (!record(value)) invalid();
  for (const [key, item] of Object.entries(value)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key) || typeof item !== 'string' || item.length > 1024 * 1024) invalid();
    if (key === 'nightjar_profile' && !validateAndRepairProfile(JSON.parse(item))) invalid();
    if (key === 'nightjar_theme' && !['dark', 'light', 'system'].includes(item)) invalid();
    if (key === 'nightjar_density' && !['comfortable', 'compact'].includes(item)) invalid();
    if (key === 'nightjar_last_destination' && !['/', '/jobs', '/applications'].includes(item)) invalid();
    if (['nightjar_watch_alerts', 'nightjar_alert_setup_dismissed', 'nightjar_onboarding_dismissed'].includes(key) && !['true', 'false'].includes(item)) invalid();
    if (key === 'nightjar_watched_companies') {
      const watches: unknown = JSON.parse(item);
      if (!Array.isArray(watches) || !watches.every(w => record(w) && ['slug', 'name', 'since'].every(k => typeof w[k] === 'string'))) invalid();
    }
    if (key === 'nightjar_watch_alert_seen') {
      const ids: unknown = JSON.parse(item); if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) invalid();
    }
  }
}

export function parseWorkspaceBackup(text: string): WorkspaceBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 60 MB limit.');
  const b: unknown = JSON.parse(text);
  if (!record(b) || b.format !== 'nightjar-workspace' || b.version !== 1 || typeof b.created_at !== 'string'
    || !Number.isFinite(Date.parse(b.created_at)) || !record(b.tables)) invalid();
  validateSettings(b.settings);
  if (Object.keys(b.tables).length !== tables.length) invalid();
  let total = 0;
  for (const table of tables) {
    const rows = b.tables[table]; if (!Array.isArray(rows)) invalid();
    total += rows.length; if (total > 100000) throw new Error('Backup exceeds the supported 100,000 record limit.');
    const columns = COLUMNS[table].split(' '); const ids = new Set<unknown>();
    for (const row of rows) {
      if (!record(row) || Object.keys(row).length !== columns.length || !columns.every(c => Object.hasOwn(row, c))) invalid();
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') invalid();
        if (typeof value === 'number' && !Number.isFinite(value)) invalid();
        if (typeof value === 'string' && value.length > 1024 * 1024) invalid();
        const numeric = ['classification_version', 'score', 'interview_rounds'].includes(key) || (table === 'application_outcome_events' && key === 'id');
        if (value !== null && (numeric ? typeof value !== 'number' : typeof value !== 'string')) invalid();
      }
      const id = row[primaryKeys[table]]; if (id === null || id === '' || ids.has(id)) invalid(); ids.add(id);
      if (table === 'postings_cache' && (typeof row.data !== 'string' || !record(JSON.parse(row.data)) || typeof row.synced_at !== 'string')) invalid();
      if (table === 'applications' && (!isApplicationStatus(String(row.status))
        || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string')) invalid();
      if (Object.hasOwn(row, 'interview_rounds') && (!Number.isInteger(row.interview_rounds) || Number(row.interview_rounds) < 0)) invalid();
      if (table === 'application_outcome_events' && (!['interview','offer','rejection','ghosted','withdrawn'].includes(String(row.outcome)) || typeof row.occurred_at !== 'string')) invalid();
      if (table === 'recalibration_suggestion_actions' && (!['applied','dismissed'].includes(String(row.status)) || typeof row.acted_at !== 'string')) invalid();
      if (table === 'companies_meta' && typeof row.name !== 'string') invalid();
    }
  }
  const result = b as unknown as WorkspaceBackup;
  const postingIds = new Set(result.tables.postings_cache.map(r => r.id));
  const applicationIds = new Set(result.tables.applications.map(r => r.posting_id));
  if (result.tables.applications.some(r => !postingIds.has(r.posting_id))
    || result.tables.application_outcome_events.some(r => !applicationIds.has(r.posting_id))) invalid();
  return result;
}

export async function createWorkspaceBackup(db: Database): Promise<string> {
  const rows = {} as WorkspaceBackup['tables'];
  await db.transaction(async tx => {
    for (const table of tables) rows[table] = await tx.query<Row>(`SELECT ${COLUMNS[table].split(' ').join(',')} FROM ${table}`);
  });
  const text = JSON.stringify({ format: 'nightjar-workspace', version: 1, created_at: new Date().toISOString(), settings: readWorkspaceSettings(), tables: rows });
  parseWorkspaceBackup(text); // Never claim to have created a backup we cannot restore.
  return text;
}

export async function finishPendingRestore(db: Database): Promise<void> {
  if (!await db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_restore_journal'")) return;
  const pending = await db.queryOne<{settings: string}>('SELECT settings FROM workspace_restore_journal WHERE id=1');
  if (!pending) return;
  const settings: unknown = JSON.parse(pending.settings); validateSettings(settings);
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    if (value === undefined) localStorage.removeItem(key); else localStorage.setItem(key, value);
  }
  // Imported caches must be checked against the public source again.
  for (const key of ['nightjar_feed_meta_sha','nightjar_shard_hashes','nightjar_feed_last_modified','nightjar_cache_integrity']) localStorage.removeItem(key);
  await db.run('DELETE FROM workspace_restore_journal WHERE id=1');
}

export async function restoreWorkspace(db: Database, backup: WorkspaceBackup): Promise<void> {
  const checked = parseWorkspaceBackup(JSON.stringify(backup));
  await db.transaction(async tx => {
    await tx.exec('CREATE TABLE IF NOT EXISTS workspace_restore_journal(id INTEGER PRIMARY KEY,settings TEXT NOT NULL)');
    for (const table of ['job_details_cache','gmail_suggestions','application_outcome_events','recalibration_suggestion_actions','applications','companies_meta']) await tx.run(`DELETE FROM ${table}`);
    for (const table of tables) {
      const columns = COLUMNS[table].split(' ');
      const batchSize = Math.floor(256 / columns.length);
      const rows = checked.tables[table];
      for (let index = 0; index < rows.length; index += batchSize) {
        const batch = rows.slice(index, index + batchSize);
        const conflict = table === 'postings_cache' ? ' ON CONFLICT(id) DO NOTHING' : '';
        const values = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
        await tx.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${values}${conflict}`, batch.flatMap(row => columns.map(c => row[c] as SqlValue)));
      }
    }
    await tx.run('INSERT OR REPLACE INTO workspace_restore_journal(id,settings) VALUES (1,?)', [JSON.stringify(checked.settings)]);
  });
  await finishPendingRestore(db);
}
