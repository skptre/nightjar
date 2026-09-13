import { afterEach, expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { syncFeed, computeSha256 } from './feed-sync';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); });
it.each([true, false])('loads actual bundled jobs on a fresh packaged launch, online: %s', async online => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  vi.stubEnv('DEV', false);
  const db = await NightjarDB.createInMemory();
  const feed = JSON.stringify({ version: 1, count: 1, postings: { sample: { id: 'sample', company: 'Example', company_slug: 'example', title: 'Engineering Intern', source: 'greenhouse', url: 'https://example.com/job', first_seen_at: '2026-09-10', last_seen_at: '2026-09-10', closed_at: null, description_text: 'Build aircraft.' } }, updated_at: '2026-09-10' });
  const sha256 = await computeSha256(feed);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('https://')) return new Response('', { status: 404 });
    if (url === '/data/meta.json') return new Response(JSON.stringify({ sha256, count: 1, updated_at: '2026-09-10' }));
    if (url === '/data/feed.json') return new Response(feed);
    return new Response('', { status: 404 });
  }));
  try {
    expect((await syncFeed(db)).error).toBeUndefined();
    expect(await db.queryOne('SELECT id, description FROM postings_cache')).toEqual({ id: 'sample', description: 'Build aircraft.' });
  }
  finally { await db.close(); }
});
it('does not replace an existing cache with the bundled fallback', async () => {
  vi.stubEnv('DEV', false);
  const db = await NightjarDB.createInMemory();
  await db.run("INSERT INTO postings_cache(id,data,synced_at) VALUES ('existing','{}','today')");
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return new Response('', { status: 404 }); }));
  try {
    expect((await syncFeed(db)).error).toBeTruthy();
    expect(requests.every(url => url.startsWith('https://'))).toBe(true);
  } finally { await db.close(); }
});
