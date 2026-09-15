import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { syncFeed } from '@/sync/feed-sync';
import { createWorkspaceBackup, parseWorkspaceBackup, restoreWorkspace } from '@/backup/workspace';

// Explicit local release check. Never makes network requests or uses personal data.
const release = process.env['NIGHTJAR_RELEASE_DIR'];
afterEach(() => vi.unstubAllGlobals());
it.skipIf(!release)('imports every staged public description intact through real app sync', async () => {
  const root = resolve(release);
  const feed = JSON.parse(readFileSync(resolve(root, 'feed.json'), 'utf8'));
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(input), 'https://release.example');
    const path = url.pathname.replace(/^\/candidate\//, '');
    if (!/^(?:meta\.json|feed\.json|feed\/(?:[a-z_-]+\.json|details\/(?:descriptions-[a-f0-9]|[a-f0-9-]+)\.json))$/.test(path)) {
      return new Response('', { status: 404 });
    }
    try { return new Response(readFileSync(resolve(root, path), 'utf8')); }
    catch { return new Response('', { status: 404 }); }
  }));
  const db = await NightjarDB.createInMemory();
  try {
    const result = await syncFeed(db, '/candidate');
    expect(result.error).toBeUndefined();
    const rows = await db.query('SELECT id,description FROM postings_cache');
    expect(rows.length).toBe(Object.keys(feed.postings).length);
    let descriptions = 0;
    for (const row of rows) {
      const expected = feed.postings[row.id]?.description_text || null;
      expect(row.description, row.id).toBe(expected);
      if (row.description) descriptions++;
    }
    expect(descriptions).toBeGreaterThan(0);
    const first = rows[0].id;
    await db.run("INSERT INTO applications(posting_id,status,notes,created_at,updated_at) VALUES (?,'oa','Recovery test note','2026-09-15','2026-09-15')", [first]);
    const backup = parseWorkspaceBackup(await createWorkspaceBackup(db));
    const restored = await NightjarDB.createInMemory();
    try {
      await restoreWorkspace(restored, backup);
      expect(await restored.queryOne('SELECT notes,status FROM applications')).toEqual({notes:'Recovery test note',status:'oa'});
      expect((await restored.query('SELECT id FROM postings_cache')).length).toBe(rows.length);
      expect((await restored.query('SELECT id FROM postings_cache WHERE description IS NOT NULL')).length).toBe(descriptions);
    } finally { await restored.close(); }
    console.info(`Release verified: ${rows.length} postings; ${descriptions} exact descriptions.`);
  } finally { await db.close(); }
}, 60000);
