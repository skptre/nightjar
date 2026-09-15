import { afterEach, beforeEach, expect, it } from 'vitest';
import { vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { createWorkspaceBackup, parseWorkspaceBackup, restoreWorkspace, finishPendingRestore } from './workspace';

let db: NightjarDB;
beforeEach(async () => {
  localStorage.clear();
  db = await NightjarDB.createInMemory();
  await db.run("INSERT INTO postings_cache(id,data,synced_at) VALUES ('job','{}','today')");
  await db.run("INSERT INTO applications(posting_id,status,notes,created_at,updated_at) VALUES ('job','applied','private note','today','today')");
});
afterEach(async () => { await db.close(); localStorage.clear(); });

it('round trips applications, history, preferences and watches without credentials', async () => {
  localStorage.setItem('nightjar_theme', 'light');
  localStorage.setItem('nightjar_watched_companies', '[{"slug":"acme","name":"Acme","since":"2026-09-15"}]');
  localStorage.setItem('nightjar_gmail_tokens', 'secret');
  const text = await createWorkspaceBackup(db);
  expect(text).not.toContain('secret');
  const backup = parseWorkspaceBackup(text);
  await db.run("UPDATE applications SET notes='changed'");
  localStorage.setItem('nightjar_theme', 'dark');
  await restoreWorkspace(db, backup);
  expect((await db.queryOne<{notes: string}>('SELECT notes FROM applications'))?.notes).toBe('private note');
  expect(localStorage.getItem('nightjar_theme')).toBe('light');
});

it('rejects unknown versions, columns, settings, broken relationships and invalid data before writing', async () => {
  const backup = JSON.parse(await createWorkspaceBackup(db));
  for (const mutate of [
    (b: typeof backup) => { b.version = 99; },
    (b: typeof backup) => { b.settings.nightjar_feed_url_override = 'https://evil.example'; },
    (b: typeof backup) => { b.tables.applications[0].injected = 'bad'; },
    (b: typeof backup) => { b.tables.applications[0].posting_id = 'missing'; },
    (b: typeof backup) => { b.tables.applications[0].status = '<script>'; },
  ]) {
    const copy = structuredClone(backup); mutate(copy);
    expect(() => parseWorkspaceBackup(JSON.stringify(copy))).toThrow();
  }
  expect((await db.queryOne<{notes:string}>('SELECT notes FROM applications'))?.notes).toBe('private note');
});

it('retains postings fetched since the backup and can finish preferences after interrupted restore', async () => {
  const backup = parseWorkspaceBackup(await createWorkspaceBackup(db));
  await db.run("INSERT INTO postings_cache(id,data,synced_at) VALUES ('newer','{}','today')");
  await restoreWorkspace(db, backup);
  expect(await db.queryOne("SELECT id FROM postings_cache WHERE id='newer'")).toBeTruthy();
  await db.run('INSERT OR REPLACE INTO workspace_restore_journal(id,settings) VALUES (1,?)', ['{"nightjar_theme":"light"}']);
  await finishPendingRestore(db);
  expect(localStorage.getItem('nightjar_theme')).toBe('light');
  expect(await db.queryOne('SELECT * FROM workspace_restore_journal')).toBeUndefined();
});

it('rolls back a failed database restore without changing the existing tracker or preferences', async () => {
  const backup = parseWorkspaceBackup(await createWorkspaceBackup(db));
  await db.run("UPDATE applications SET notes='current'");
  const original = db.transaction.bind(db);
  vi.spyOn(db,'transaction').mockImplementationOnce(fn => original(async tx => {
    await fn(tx); throw new Error('disk failure');
  }));
  await expect(restoreWorkspace(db,backup)).rejects.toThrow('disk failure');
  expect((await db.queryOne<{notes:string}>('SELECT notes FROM applications'))?.notes).toBe('current');
});
