import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserDatabase } from './browser-database';

class TestWorker {
  static instance: TestWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: { id: number; action: string; sql?: string }[] = [];
  terminate = vi.fn();
  constructor() { TestWorker.instance = this; }
  postMessage(message: { id: number; action: string; sql?: string }): void {
    this.requests.push(message);
    queueMicrotask(() => this.onmessage?.({ data: {
      id: message.id, result: message.action === 'query' ? [{ value: 42 }] : undefined,
    } } as MessageEvent));
  }
}
beforeEach(() => vi.stubGlobal('Worker', TestWorker));
afterEach(() => vi.unstubAllGlobals());

it('queues unrelated reads until an atomic transaction commits', async () => {
  const db = await BrowserDatabase.create();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const work = db.transaction(async tx => { await tx.run('inside'); await paused; });
  const read = db.queryOne('outside');
  await vi.waitFor(() => expect(TestWorker.instance.requests.map(r => r.action)).toContain('run'));
  expect(TestWorker.instance.requests.some(r => r.sql === 'outside')).toBe(false);
  release();
  await work;
  expect(await read).toEqual({ value: 42 });
  expect(TestWorker.instance.requests.map(r => r.action)).toEqual(['open', 'begin', 'run', 'commit', 'query']);
  await db.close();
});

it('rolls back a failed callback and leaves the queue usable', async () => {
  const db = await BrowserDatabase.create();
  await expect(db.transaction(async tx => { await tx.run('inside'); throw new Error('cancel'); })).rejects.toThrow('cancel');
  expect(TestWorker.instance.requests.map(r => r.action)).toEqual(['open', 'begin', 'run', 'rollback']);
  expect(await db.queryOne('read')).toEqual({ value: 42 });
  await db.close();
});

it('reports storage failures and rejects subsequent calls after the worker fails', async () => {
  const db = await BrowserDatabase.create();
  const savedError = vi.fn();
  window.addEventListener('nightjar:save-error', savedError);
  try {
    TestWorker.instance.onmessage?.({ data: { event: 'save-error' } } as MessageEvent);
    expect(savedError).toHaveBeenCalledOnce();
    TestWorker.instance.onerror?.();
    await expect(db.query('read')).rejects.toThrow('local database worker');
    await expect(db.close()).rejects.toThrow('local database worker');
    expect(TestWorker.instance.terminate).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('nightjar:save-error', savedError); }
});
