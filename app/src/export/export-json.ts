import type { Database } from '@/db/types';
import { type ApplicationRow, queryApplicationRows } from './export-csv';

export interface ApplicationExport {
  exported_at: string;
  count: number;
  version: string;
  applications: ApplicationRow[];
  outcome_events: OutcomeEventExport[];
}

export interface OutcomeEventExport {
  posting_id: string;
  outcome: string;
  occurred_at: string;
  interview_rounds: number;
  notes: string | null;
}

export async function exportApplicationsJSON(db: Database): Promise<string> {
  const rows = await queryApplicationRows(db);
  const outcomeEvents = await db.query<OutcomeEventExport>(
    `SELECT posting_id, outcome, occurred_at, interview_rounds, notes
     FROM application_outcome_events
     ORDER BY occurred_at, id`,
  );
  const output: ApplicationExport = {
    exported_at: new Date().toISOString(),
    count: rows.length,
    version: '0.1.0',
    applications: rows,
    outcome_events: outcomeEvents,
  };
  return JSON.stringify(output, null, 2);
}
