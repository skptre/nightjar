import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { syncFeed } from '@/sync/feed-sync';

// Explicit local release check. Never makes network requests or uses personal data.
const release = process.env['NIGHTJAR_RELEASE_DIR'];
afterEach(() => vi.unstubAllGlobals());
it.skipIf(!release)('imports every staged public description intact through real app sync', async () => {
  const root = resolve(release);
  const feed = JSON.parse(readFileSync(resolve(root, 'feed.json'), 'utf8'));
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(input), 'https://release.example');
    const path = url.pathname.replace(/^\/candidate\//, '');
    if (!/^(?:meta\.json|feed\.json|feed\/(?:[a-z_-]+\.json|details\/[a-f0-9-]+\.json))$/.test(path)) {
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
    console.info(`Release verified: ${rows.length} postings; ${descriptions} exact descriptions.`);
  } finally { await db.close(); }
}, 60000);
