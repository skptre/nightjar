import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { TauriDatabase } from '@/db/tauri-database';
import { syncFeed } from '@/sync/feed-sync';
import { refreshJobDetails } from '@/details/cache';
import { recomputeGuestCategories } from '@/classify/guest-classification';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => bridge);
vi.mock('@/lib/platform', () => ({ isTauri: () => true }));
it.skipIf(!process.env.NIGHTJAR_RELEASE_DIR)('imports and classifies the full feed through native-shaped batches', async () => {
  const backing = await NightjarDB.createInMemory();
  const root = resolve(process.env.NIGHTJAR_RELEASE_DIR);
  localStorage.clear();
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === 'execute_sql_query') return backing.query(args.query.replace(/\$\d+/g, '?'), args.values);
    if (command !== 'execute_sql_batch') throw new Error(command);
    expect(args.statements.length).toBeLessThanOrEqual(10000);
    const size = args.statements.reduce((sum, stmt) => sum + stmt.values.reduce((n, v) => n + (typeof v === 'string' ? new TextEncoder().encode(v).length : 0), 0), 0);
    expect(size).toBeLessThanOrEqual(64 * 1024 * 1024);
    return backing.transaction(async tx => {
      for (const stmt of args.statements) await tx.run(stmt.query.replace(/\$\d+/g, '?'), stmt.values);
    });
  });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const path = new URL(String(input), 'https://local.example').pathname.replace(/^\/candidate\//, '');
    if (!/^(?:meta\.json|feed\.json|feed\/(?:[a-z_-]+\.json|details\/descriptions-[a-f0-9]\.json))$/.test(path)) return new Response('', { status: 404 });
    return new Response(readFileSync(resolve(root, path), 'utf8'));
  }));
  try {
    const db = await TauriDatabase.create();
    expect((await syncFeed(db, '/candidate')).error).toBeUndefined();
    await refreshJobDetails(db, null);
    await recomputeGuestCategories(db);
    const expected = JSON.parse(readFileSync(resolve(root, 'feed.json'), 'utf8'));
    expect(await db.queryOne('SELECT COUNT(*) AS count FROM postings_cache')).toEqual({ count: expected.count });
    expect(await db.queryOne('SELECT COUNT(*) AS count FROM job_details_cache')).toEqual({ count: expected.count });
  } finally { vi.unstubAllGlobals(); await backing.close(); }
}, 120000);
