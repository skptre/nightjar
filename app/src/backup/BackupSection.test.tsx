import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { BackupSection } from './BackupSection';
import { createWorkspaceBackup } from './workspace';
const state = vi.hoisted(() => ({db: null as unknown, save:vi.fn()}));
vi.mock('@/providers/DatabaseProvider', () => ({useDatabase: () => ({db:state.db})}));
vi.mock('@/export/file-save', () => ({saveFile:state.save}));
let db: NightjarDB;
beforeEach(async () => {
  localStorage.clear(); state.save.mockReset(); db=await NightjarDB.createInMemory(); state.db=db;
  await db.run("INSERT INTO postings_cache(id,data,synced_at) VALUES ('job','{}','2026-09-15')");
  await db.run("INSERT INTO applications(posting_id,status,notes,created_at,updated_at) VALUES ('job','saved','keep','2026-09-15','2026-09-15')");
});
afterEach(async () => {cleanup(); await db.close();});
it('previews a backup and cancels without changing the tracker', async () => {
  const text=await createWorkspaceBackup(db); render(<BackupSection />);
  fireEvent.change(screen.getByLabelText('Workspace backup file'),{target:{files:[{size:text.length,text:async () => text}]}});
  await screen.findByRole('button',{name:'Restore and reload'});
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(screen.queryByRole('button',{name:'Restore and reload'})).toBeNull();
  expect((await db.queryOne<{notes:string}>('SELECT notes FROM applications'))?.notes).toBe('keep');
});
it('does not report success when the native save dialog is cancelled', async () => {
  state.save.mockResolvedValue(null); render(<BackupSection />);
  fireEvent.click(screen.getByRole('button',{name:'Save workspace backup'}));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(screen.queryByText('Workspace backup saved.')).toBeNull();
});
it('rejects oversized imports before reading the file', async () => {
  const read=vi.fn(); render(<BackupSection />);
  fireEvent.change(screen.getByLabelText('Workspace backup file'),{target:{files:[{size:257*1024*1024,text:read}]}});
  await screen.findByText('Backup exceeds the 256 MB limit.'); expect(read).not.toHaveBeenCalled();
});
