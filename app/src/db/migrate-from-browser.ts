import type { Database, SqlValue } from './types';
import { loadDatabase } from './indexeddb';

interface PostingRow {
  id: string;
  data: string;
  description: string | null;
  first_seen_at: string | null;
  closed_at: string | null;
  category: string | null;
  category_tags: string | null;
  term: string | null;
  eligibility: string | null;
  score: number | null;
  score_breakdown: string | null;
  synced_at: string;
}

interface ApplicationRow {
  posting_id: string;
  status: string;
  applied_at: string | null;
  deadline: string | null;
  notes: string | null;
  next_action: string | null;
  next_action_at: string | null;
  outcome: string | null;
  outcome_at: string | null;
  interview_rounds: number;
  outcome_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface OutcomeEventRow {
  posting_id: string;
  outcome: string;
  occurred_at: string;
  interview_rounds: number;
  notes: string | null;
}

interface SuggestionActionRow {
  suggestion_id: string;
  status: string;
  acted_at: string;
}

async function hasExistingData(db: Database): Promise<boolean> {
  const row = await db.queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM postings_cache',
  );
  return (row?.count ?? 0) > 0;
}

export async function migrateFromBrowser(
  tauriDb: Database,
  loader?: () => Promise<Uint8Array | null>,
): Promise<boolean> {
  if (await hasExistingData(tauriDb)) {
    return false;
  }

  let browserData: Uint8Array | null;
  try {
    browserData = await (loader ?? loadDatabase)();
  } catch {
    return false;
  }

  if (!browserData) {
    return false;
  }

  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const sqlJsDb = new SQL.Database(browserData);

  try {
    const postings = readPostings(sqlJsDb);
    const applications = readApplications(sqlJsDb);
    const outcomeEvents = readOutcomeEvents(sqlJsDb);
    const suggestionActions = readSuggestionActions(sqlJsDb);

    if (postings.length === 0 && applications.length === 0) {
      return false;
    }

    await tauriDb.transaction(async (transaction) => {
      for (const p of postings) {
        await transaction.run(
          `INSERT OR IGNORE INTO postings_cache
           (id, data, description, first_seen_at, closed_at, category, category_tags,
            term, eligibility, score, score_breakdown, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            p.id, p.data, p.description, p.first_seen_at, p.closed_at,
            p.category, p.category_tags, p.term, p.eligibility, p.score,
            p.score_breakdown, p.synced_at,
          ],
        );
      }

      for (const a of applications) {
        await transaction.run(
          `INSERT OR IGNORE INTO applications
           (posting_id, status, applied_at, deadline, notes, next_action,
            next_action_at, outcome, outcome_at, interview_rounds, outcome_notes,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.posting_id, a.status, a.applied_at, a.deadline, a.notes,
            a.next_action, a.next_action_at, a.outcome, a.outcome_at,
            a.interview_rounds, a.outcome_notes, a.created_at, a.updated_at,
          ],
        );
      }

      for (const event of outcomeEvents) {
        await transaction.run(
          `INSERT INTO application_outcome_events
           (posting_id, outcome, occurred_at, interview_rounds, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [
            event.posting_id, event.outcome, event.occurred_at,
            event.interview_rounds, event.notes,
          ],
        );
      }

      for (const action of suggestionActions) {
        await transaction.run(
          `INSERT OR IGNORE INTO recalibration_suggestion_actions
           (suggestion_id, status, acted_at)
           VALUES (?, ?, ?)`,
          [action.suggestion_id, action.status, action.acted_at],
        );
      }
    });

    await clearBrowserDatabase();
    return true;
  } finally {
    sqlJsDb.close();
  }
}

function readPostings(db: import('sql.js').Database): PostingRow[] {
  const rows: PostingRow[] = [];
  const columns = tableColumns(db, 'postings_cache');
  const categoryTags = columns.has('category_tags') ? 'category_tags' : 'NULL AS category_tags';
  const stmt = db.prepare(
    `SELECT id, data, description, first_seen_at, closed_at, category, term,
            ${categoryTags}, eligibility, score, score_breakdown, synced_at
     FROM postings_cache`,
  );
  try {
    while (stmt.step()) {
      const obj = stmt.getAsObject() as Record<string, SqlValue>;
      rows.push({
        id: obj['id'] as string,
        data: obj['data'] as string,
        description: (obj['description'] as string | null) ?? null,
        first_seen_at: (obj['first_seen_at'] as string | null) ?? null,
        closed_at: (obj['closed_at'] as string | null) ?? null,
        category: (obj['category'] as string | null) ?? null,
        category_tags: (obj['category_tags'] as string | null) ?? null,
        term: (obj['term'] as string | null) ?? null,
        eligibility: (obj['eligibility'] as string | null) ?? null,
        score: (obj['score'] as number | null) ?? null,
        score_breakdown: (obj['score_breakdown'] as string | null) ?? null,
        synced_at: obj['synced_at'] as string,
      });
    }
  } finally {
    stmt.free();
  }
  return rows;
}

function readApplications(db: import('sql.js').Database): ApplicationRow[] {
  const rows: ApplicationRow[] = [];
  const columns = tableColumns(db, 'applications');
  const optional = (name: string, fallback: string): string => (
    columns.has(name) ? name : `${fallback} AS ${name}`
  );
  const stmt = db.prepare(
    `SELECT posting_id, status, applied_at, deadline, notes, next_action,
            next_action_at, ${optional('outcome', 'NULL')},
            ${optional('outcome_at', 'NULL')},
            ${optional('interview_rounds', '0')},
            ${optional('outcome_notes', 'NULL')}, created_at, updated_at
     FROM applications`,
  );
  try {
    while (stmt.step()) {
      const obj = stmt.getAsObject() as Record<string, SqlValue>;
      rows.push({
        posting_id: obj['posting_id'] as string,
        status: obj['status'] as string,
        applied_at: (obj['applied_at'] as string | null) ?? null,
        deadline: (obj['deadline'] as string | null) ?? null,
        notes: (obj['notes'] as string | null) ?? null,
        next_action: (obj['next_action'] as string | null) ?? null,
        next_action_at: (obj['next_action_at'] as string | null) ?? null,
        outcome: (obj['outcome'] as string | null) ?? null,
        outcome_at: (obj['outcome_at'] as string | null) ?? null,
        interview_rounds: (obj['interview_rounds'] as number | null) ?? 0,
        outcome_notes: (obj['outcome_notes'] as string | null) ?? null,
        created_at: obj['created_at'] as string,
        updated_at: obj['updated_at'] as string,
      });
    }
  } finally {
    stmt.free();
  }
  return rows;
}

function tableColumns(db: import('sql.js').Database, table: string): Set<string> {
  const columns = new Set<string>();
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  try {
    while (stmt.step()) {
      const obj = stmt.getAsObject() as Record<string, SqlValue>;
      if (typeof obj['name'] === 'string') columns.add(obj['name']);
    }
  } finally {
    stmt.free();
  }
  return columns;
}

function tableExists(db: import('sql.js').Database, table: string): boolean {
  const stmt = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  );
  try {
    stmt.bind([table]);
    return stmt.step();
  } finally {
    stmt.free();
  }
}

function readOutcomeEvents(db: import('sql.js').Database): OutcomeEventRow[] {
  if (!tableExists(db, 'application_outcome_events')) return [];
  const rows: OutcomeEventRow[] = [];
  const stmt = db.prepare(
    `SELECT posting_id, outcome, occurred_at, interview_rounds, notes
     FROM application_outcome_events ORDER BY id`,
  );
  try {
    while (stmt.step()) {
      const obj = stmt.getAsObject() as Record<string, SqlValue>;
      rows.push({
        posting_id: obj['posting_id'] as string,
        outcome: obj['outcome'] as string,
        occurred_at: obj['occurred_at'] as string,
        interview_rounds: (obj['interview_rounds'] as number | null) ?? 0,
        notes: (obj['notes'] as string | null) ?? null,
      });
    }
  } finally {
    stmt.free();
  }
  return rows;
}

function readSuggestionActions(db: import('sql.js').Database): SuggestionActionRow[] {
  if (!tableExists(db, 'recalibration_suggestion_actions')) return [];
  const rows: SuggestionActionRow[] = [];
  const stmt = db.prepare(
    `SELECT suggestion_id, status, acted_at
     FROM recalibration_suggestion_actions ORDER BY suggestion_id`,
  );
  try {
    while (stmt.step()) {
      const obj = stmt.getAsObject() as Record<string, SqlValue>;
      rows.push({
        suggestion_id: obj['suggestion_id'] as string,
        status: obj['status'] as string,
        acted_at: obj['acted_at'] as string,
      });
    }
  } finally {
    stmt.free();
  }
  return rows;
}

async function clearBrowserDatabase(): Promise<void> {
  try {
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nightjar', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = idb.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').delete('database');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
  } catch {
    // Non-critical — stale IndexedDB data won't cause issues
  }
}
