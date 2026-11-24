import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { TauriDatabase } from '@/db/tauri-database';
import { syncFeed } from '@/sync/feed-sync';
import { CURRENT_JOBS_QUERY } from '@/views/Feed/FeedView';
import { refreshJobDetails } from '@/details/cache';
import { recomputeGuestCategories } from '@/classify/guest-classification';
import { createWorkspaceBackup, parseWorkspaceBackup, restoreWorkspace } from '@/backup/workspace';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => bridge);
vi.mock('@/lib/platform', () => ({ isTauri: () => true }));
it.skipIf(!process.env.NIGHTJAR_RELEASE_DIR)('imports and classifies the full feed through native-shaped batches', async () => {
  const backing = await NightjarDB.createInMemory();
  const root = resolve(process.env.NIGHTJAR_RELEASE_DIR);
  const feedBatchSizes = [];
  let queryBytes = 0;
  const timing = {};
  const started = performance.now();
  localStorage.clear();
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === 'execute_sql_query') {
      const result = await backing.query(args.query.replace(/\$\d+/g, '?'), args.values);
      queryBytes += JSON.stringify(result).length;
      return result;
    }
    if (command !== 'execute_sql_batch') throw new Error(command);
    feedBatchSizes.push(args.statements.length);
    expect(args.statements.length).toBeLessThanOrEqual(10000);
    const size = args.statements.reduce((sum, stmt) => sum + stmt.values.reduce((n, v) => n + (typeof v === 'string' ? new TextEncoder().encode(v).length : 0), 0), 0);
    expect(size).toBeLessThanOrEqual(128 * 1024 * 1024);
    return backing.transaction(async tx => {
      for (const stmt of args.statements) await tx.run(stmt.query.replace(/\$\d+/g, '?'), stmt.values);
    });
  });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const path = new URL(String(input), 'https://local.example').pathname.replace(/^\/candidate\//, '');
    if (!/^(?:meta\.json|feed\.json|feed\/(?:[a-z_-]+\.json|snapshots\/[a-f0-9]{64}\.json|details\/(?:descriptions-[a-f0-9]|[a-f0-9]{2}-[a-f0-9]{64})\.json))$/.test(path)) return new Response('', { status: 404 });
    return new Response(readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n'));
  }));
  try {
    const db = await TauriDatabase.create();
    expect((await syncFeed(db, '/candidate')).error).toBeUndefined();
    expect(feedBatchSizes.length).toBeGreaterThan(30);
    expect(Math.max(...feedBatchSizes)).toBeLessThanOrEqual(200);
    timing.importMs = Math.round(performance.now() - started);
    await refreshJobDetails(db, null);
    await recomputeGuestCategories(db);
    timing.coldMs = Math.round(performance.now() - started);
    const warmStart = performance.now(); queryBytes = 0;
    expect(await refreshJobDetails(db, null)).toBe(0);
    expect(await recomputeGuestCategories(db)).toBe(0);
    timing.warmMs = Math.round(performance.now() - warmStart);
    timing.warmQueryBytes = queryBytes;
    expect(queryBytes).toBeLessThan(100);
    queryBytes = 0;
    const listStart = performance.now();
    const list = await db.query(CURRENT_JOBS_QUERY);
    timing.listMs = Math.round(performance.now() - listStart);
    timing.listBytes = queryBytes;
    const recovery = parseWorkspaceBackup(await createWorkspaceBackup(db, true));
    expect(recovery.tables.postings_cache).toHaveLength(0);
    expect(queryBytes).toBeLessThan(list.length * 1800);
    process.stdout.write(`Full feed performance ${JSON.stringify({...timing, visibleRows: list.length})}\n`);
    const expected = JSON.parse(readFileSync(resolve(root, 'feed.json'), 'utf8'));
    const openCount = Object.values(expected.postings).filter(p => !p.closed_at).length;
    expect(list).toHaveLength(openCount);
    expect(await db.queryOne('SELECT COUNT(*) AS count FROM postings_cache')).toEqual({ count: openCount });
    expect(await db.queryOne('SELECT COUNT(*) AS count FROM job_details_cache')).toEqual({ count: openCount });
    const backup = await createWorkspaceBackup(db);
    const parsed = parseWorkspaceBackup(backup);
    expect(parsed.tables.postings_cache).toHaveLength(openCount);
    await restoreWorkspace(db, parsed);
    expect(await db.queryOne('SELECT COUNT(*) AS count FROM postings_cache')).toEqual({ count: openCount });
  } finally { vi.unstubAllGlobals(); await backing.close(); }
}, 240000);
