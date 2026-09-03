import type { Database } from '@/db/database';
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
  db: Database,
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
  await db.transaction(async () => {
    await writeOutcome(
      db,
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

  await db.transaction(async () => {
    await db.run(
      `UPDATE applications
       SET status = ?, applied_at = ?, updated_at = ?
       WHERE posting_id = ?`,
      [newStatus, appliedAt, occurredAt, postingId],
    );

    if (outcome) {
      await writeOutcome(
        db,
        postingId,
        outcome,
        application.interview_rounds,
        normalized,
        occurredAt,
      );
    } else {
      await db.run(
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
