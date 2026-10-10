import type { Database } from '@/db/database';
import type { DatabaseTransaction } from '@/db/types';
import {
  outcomeForStatus,
  type ApplicationStatus,
  type ApplicationOutcome,
  type OutcomeDetails,
  type SuggestionDecision,
} from './types';

const MAX_OUTCOME_NOTES = 400;
const MAX_INTERVIEW_ROUNDS = 20;
const APPLIED_OR_LATER = new Set<string>([
  'applied', 'oa', 'phone', 'onsite', 'offer', 'rejected', 'ghosted',
]);

interface ApplicationRow {
  status: string;
  applied_at: string | null;
  interview_rounds: number;
}

interface NormalizedDetails {
  notes: string | null;
  interviewRounds: number | null;
}

function normalizeDetails(details: OutcomeDetails): NormalizedDetails {
  const trimmed = details.notes?.trim().slice(0, MAX_OUTCOME_NOTES) ?? '';
  const rawRounds = details.interviewRounds;
  const interviewRounds = typeof rawRounds === 'number' && Number.isFinite(rawRounds)
    ? Math.max(0, Math.min(MAX_INTERVIEW_ROUNDS, Math.trunc(rawRounds)))
    : null;
  return {
    notes: trimmed.length > 0 ? trimmed : null,
    interviewRounds,
  };
}

async function requireApplication(db: Database, postingId: string): Promise<ApplicationRow> {
  const row = await db.queryOne<ApplicationRow>(
    'SELECT status, applied_at, interview_rounds FROM applications WHERE posting_id = ?',
    [postingId],
  );
  if (!row) throw new Error(`Application not found: ${postingId}`);
  return row;
}

async function writeOutcome(
  db: DatabaseTransaction,
  postingId: string,
  outcome: ApplicationOutcome,
  currentRounds: number,
  details: NormalizedDetails,
  occurredAt: string,
): Promise<void> {
  const interviewRounds = Math.max(currentRounds, details.interviewRounds ?? currentRounds);
  await db.run(
    `UPDATE applications
     SET outcome = ?, outcome_at = ?, interview_rounds = ?, outcome_notes = ?, updated_at = ?
     WHERE posting_id = ?`,
    [outcome, occurredAt, interviewRounds, details.notes, occurredAt, postingId],
  );
  await db.run(
    `INSERT INTO application_outcome_events
     (posting_id, outcome, occurred_at, interview_rounds, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [postingId, outcome, occurredAt, details.interviewRounds ?? 0, details.notes],
  );
}

export async function recordApplicationOutcome(
  db: Database,
  postingId: string,
  outcome: ApplicationOutcome,
  details: OutcomeDetails = {},
  now: Date = new Date(),
): Promise<void> {
  const application = await requireApplication(db, postingId);
  const normalized = normalizeDetails(details);
  const occurredAt = now.toISOString();
  await db.transaction(async (transaction) => {
    await writeOutcome(
      transaction,
      postingId,
      outcome,
      application.interview_rounds,
      normalized,
      occurredAt,
    );
  });
}

export async function transitionApplicationStatus(
  db: Database,
  postingId: string,
  newStatus: ApplicationStatus,
  details: OutcomeDetails = {},
  now: Date = new Date(),
): Promise<void> {
  const application = await requireApplication(db, postingId);
  if (application.status === newStatus) return;

  const occurredAt = now.toISOString();
  const normalized = normalizeDetails(details);
  const outcome = outcomeForStatus(newStatus);
  const appliedAt = application.applied_at
    ?? (APPLIED_OR_LATER.has(newStatus) ? occurredAt : null);

  await db.transaction(async (transaction) => {
    await transaction.run(
      `UPDATE applications
       SET status = ?, applied_at = ?, updated_at = ?
       WHERE posting_id = ?`,
      [newStatus, appliedAt, occurredAt, postingId],
    );

    if (outcome) {
      await writeOutcome(
        transaction,
        postingId,
        outcome,
        application.interview_rounds,
        normalized,
        occurredAt,
      );
    } else {
      await transaction.run(
        `UPDATE applications
         SET outcome = NULL, outcome_at = NULL, outcome_notes = NULL
         WHERE posting_id = ?`,
        [postingId],
      );
    }
  });
}

export async function saveSuggestionDecision(
  db: Database,
  suggestionId: string,
  status: SuggestionDecision,
  now: Date = new Date(),
): Promise<void> {
  await db.run(
    `INSERT INTO recalibration_suggestion_actions (suggestion_id, status, acted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(suggestion_id) DO UPDATE SET status = excluded.status, acted_at = excluded.acted_at`,
    [suggestionId, status, now.toISOString()],
  );
}

export async function loadSuggestionDecisions(
  db: Database,
): Promise<Record<string, SuggestionDecision>> {
  const rows = await db.query<{ suggestion_id: string; status: SuggestionDecision }>(
    'SELECT suggestion_id, status FROM recalibration_suggestion_actions ORDER BY suggestion_id',
  );
  return Object.fromEntries(rows.map((row) => [row.suggestion_id, row.status]));
}

/** Everything a stage move can change, so the move can be taken back exactly. */
export interface StatusSnapshot {
  postingId: string;
  status: string;
  applied_at: string | null;
  outcome: string | null;
  outcome_at: string | null;
  outcome_notes: string | null;
  interview_rounds: number;
  updated_at: string;
  lastEventId: number;
}

export async function snapshotApplicationStatus(db: Database, postingId: string): Promise<StatusSnapshot> {
  const row = await db.queryOne<Omit<StatusSnapshot, 'postingId' | 'lastEventId'>>(
    `SELECT status, applied_at, outcome, outcome_at, outcome_notes, interview_rounds, updated_at
     FROM applications WHERE posting_id = ?`, [postingId]);
  if (!row) throw new Error(`Application not found: ${postingId}`);
  const event = await db.queryOne<{ id: number | null }>(
    'SELECT MAX(id) AS id FROM application_outcome_events WHERE posting_id = ?', [postingId]);
  return { ...row, postingId, lastEventId: event?.id ?? 0 };
}

/** Undo a stage move: restore the row and drop history written since the snapshot. */
export async function restoreApplicationStatus(db: Database, snapshot: StatusSnapshot): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.run(
      `UPDATE applications SET status = ?, applied_at = ?, outcome = ?, outcome_at = ?, outcome_notes = ?,
       interview_rounds = ?, updated_at = ? WHERE posting_id = ?`,
      [snapshot.status, snapshot.applied_at, snapshot.outcome, snapshot.outcome_at, snapshot.outcome_notes,
        snapshot.interview_rounds, new Date().toISOString(), snapshot.postingId],
    );
    await transaction.run('DELETE FROM application_outcome_events WHERE posting_id = ? AND id > ?',
      [snapshot.postingId, snapshot.lastEventId]);
  });
}

/** Attach notes and interview rounds to the most recent outcome, after the move was made. */
export async function annotateLatestOutcome(db: Database, postingId: string, details: OutcomeDetails): Promise<void> {
  const application = await requireApplication(db, postingId);
  const normalized = normalizeDetails(details);
  const event = await db.queryOne<{ id: number }>(
    'SELECT id FROM application_outcome_events WHERE posting_id = ? ORDER BY id DESC LIMIT 1', [postingId]);
  const now = new Date().toISOString();
  const rounds = Math.max(application.interview_rounds, normalized.interviewRounds ?? application.interview_rounds);
  await db.transaction(async (transaction) => {
    await transaction.run(
      'UPDATE applications SET outcome_notes = ?, interview_rounds = ?, updated_at = ? WHERE posting_id = ?',
      [normalized.notes, rounds, now, postingId]);
    if (event) {
      await transaction.run('UPDATE application_outcome_events SET notes = ?, interview_rounds = ? WHERE id = ?',
        [normalized.notes, normalized.interviewRounds ?? 0, event.id]);
    }
  });
}
