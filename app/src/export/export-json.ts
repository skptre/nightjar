import type { Database } from '@/db/types';
import { type ApplicationRow, queryApplicationRows } from './export-csv';

export interface ApplicationExport {
  exported_at: string;
  count: number;
  version: string;
  applications: ApplicationRow[];
}

export async function exportApplicationsJSON(db: Database): Promise<string> {
  const rows = await queryApplicationRows(db);
  const output: ApplicationExport = {
    exported_at: new Date().toISOString(),
    count: rows.length,
    version: '0.1.0',
    applications: rows,
  };
  return JSON.stringify(output, null, 2);
}
