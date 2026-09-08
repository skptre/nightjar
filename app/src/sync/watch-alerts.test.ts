import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { notifyWatchedJobs } from './watch-alerts';
let db: NightjarDB;
const notify = vi.fn();
beforeEach(async () => {
  localStorage.clear(); notify.mockClear(); db = await NightjarDB.createInMemory();
  vi.stubGlobal('Notification', Object.assign(notify, { permission: 'granted' }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  for (const [id, slug] of [['one','space'], ['two','space'], ['three','other']]) {
    await db.run('INSERT INTO postings_cache (id,data,synced_at) VALUES (?,?,?)', [id!, JSON.stringify({ company_slug: slug, company: slug, title: 'Engineer' }), '2026-09-01']);
  }
  localStorage.setItem('nightjar_watched_companies', JSON.stringify([{ slug: 'space', name: 'Space', since: '2026-01-01' }]));
});
afterEach(async () => { await db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('never asks permission or interrupts without explicit opt-in', async () => {
  await notifyWatchedJobs(db,['one']); expect(notify).not.toHaveBeenCalled();
});
it('bundles watched roles, ignores other companies, and does not repeat a batch', async () => {
  localStorage.setItem('nightjar_watch_alerts', 'true');
  await notifyWatchedJobs(db,['one','two','three']);
  await notifyWatchedJobs(db,['one','two']);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[1].body).toContain('2 new roles');
});
