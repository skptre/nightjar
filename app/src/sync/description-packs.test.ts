import { afterEach, describe, expect, it, vi } from 'vitest';
import { DescriptionPackCache, hydrateDescriptions } from './description-packs';
import { NightjarDB } from '@/db/database';
import { syncFeed, getStoredMetaHash } from './feed-sync';

afterEach(() => vi.unstubAllGlobals());
const hash = async (text: string): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  .map(b => b.toString(16).padStart(2, '0')).join('');

async function fixture(text = 'Responsibilities\n\nDevelop flight software.') {
  const sha256 = await hash(text);
  const payload = JSON.stringify({ version: 1, documents: { [sha256]: text } });
  const packHash = await hash(payload);
    const ref = { sha256, pack: `details/descriptions-${sha256[0]}.json`,
      pack_sha256: packHash, status: 'available' };
  return { text, payload, ref };
}

describe('verified public documents for all jobs', () => {
  it('downloads unopened jobs into the real local cache and preserves them on corrupt refresh', async () => {
    localStorage.clear();
    const db = await NightjarDB.createInMemory();
    try {
      const f = await fixture();
      let current = f;
      let corrupt = false;
      const updated = '2026-09-07T00:00:00Z';
      const install = async () => {
        const posting = { id: 'job1', company: 'Example', company_slug: 'example',
          title: 'Software Intern', location: 'New York, NY', locations: ['New York, NY'],
          url: 'https://example.com/job/1', source: 'greenhouse', source_job_id: '1',
          ats: 'greenhouse', posted_at: null, first_seen_at: updated, last_seen_at: updated,
          closed_at: null, description_status: 'unavailable', description_version: 4,
          description_ref: current.ref };
        const shard = JSON.stringify({ shard_id: 'greenhouse', updated_at: updated,
          count: 1, postings: { job1: posting } });
        const shardHash = await hash(shard);
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
          if (url.endsWith('/meta.json')) return new Response(JSON.stringify({
            updated_at: updated, sha256: shardHash, count: 1, sharded: true,
            shards: { greenhouse: { sha256: shardHash, count: 1, updated_at: updated } },
          }));
          if (url.endsWith('/feed/greenhouse.json')) return new Response(shard);
          if (url.endsWith(current.ref.pack)) return new Response(corrupt ? '{}' : current.payload);
          return new Response('', { status: 404 });
        }));
      };
      await install();
      expect((await syncFeed(db, '/test')).error).toBeUndefined();
      const stored = await db.queryOne<{data:string}>(
        'SELECT data FROM postings_cache WHERE id = ?', ['job1']);
      expect(JSON.parse(stored!.data).description_status).toBe('available');
      const beforeHash = getStoredMetaHash();
      expect((await db.queryOne<{description:string}>(
        'SELECT description FROM postings_cache WHERE id = ?', ['job1']))?.description).toBe(f.text);
      current = await fixture('Changed requirements, including the ending.');
      corrupt = true;
      await install();
      expect((await syncFeed(db, '/test')).error).toMatch(/hash mismatch/i);
      expect(getStoredMetaHash()).toBe(beforeHash);
      expect((await db.queryOne<{description:string}>(
        'SELECT description FROM postings_cache WHERE id = ?', ['job1']))?.description).toBe(f.text);
    } finally { await db.close(); }
  });
  it('shares a pack request and preserves exact complete text', async () => {
    const f = await fixture();
    const fetchText = vi.fn(async () => f.payload);
    const cache = new DescriptionPackCache(fetchText);
    const rows = { a: { description_ref: f.ref }, b: { description_ref: f.ref } };
    const result = await hydrateDescriptions(rows, cache);
    expect(result.a?.description_text).toBe(f.text);
    expect(result.b?.description_text).toBe(f.text);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(rows.a).not.toHaveProperty('description_text');
  });

  it('reuses a verified local document when only listing information changes', async () => {
    const f = await fixture();
    const fetchText = vi.fn(async () => { throw new Error('Should not download'); });
    const cache = new DescriptionPackCache(fetchText);
    await cache.remember(f.text);
    const rows = await hydrateDescriptions({ a: { description_ref: f.ref } }, cache);
    expect(rows.a?.description_text).toBe(f.text);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('rejects a corrupt pack before returning modified postings', async () => {
    const f = await fixture();
    await expect(hydrateDescriptions({ a: { description_ref: f.ref } },
      new DescriptionPackCache(async () => '{}'))).rejects.toThrow(/hash/i);
  });

  it('validates the individual document as well as its pack', async () => {
    const f = await fixture();
    const payload = JSON.stringify({ version: 1, documents: { [f.ref.sha256]: 'Wrong text' } });
    const packHash = await hash(payload);
    const ref = { ...f.ref, pack: `details/${f.ref.sha256.slice(0, 2)}-${packHash}.json`, pack_sha256: packHash };
    await expect(hydrateDescriptions({ a: { description_ref: ref } },
      new DescriptionPackCache(async () => payload))).rejects.toThrow(/document hash/i);
  });

  it('rejects external URLs and path traversal before fetching', async () => {
    const f = await fixture();
    const fetchText = vi.fn();
    for (const pack of ['../../profile.json', 'https://example.com/private', 'details/no.json']) {
      await expect(hydrateDescriptions({ a: { description_ref: { ...f.ref, pack } } },
        new DescriptionPackCache(fetchText))).rejects.toThrow(/reference/i);
    }
    expect(fetchText).not.toHaveBeenCalled();
  });
});


it('reads fixed bundles and separates versions of the same filename', async () => {
  const first = await fixture('First description');
  // Put two distinct documents in the same fixed bucket.
  let second = await fixture('Second description');
  for (let n = 0; second.ref.sha256[0] !== first.ref.sha256[0]; n++) {
    second = await fixture(`Second description ${n}`);
  }
  const name = `details/descriptions-${first.ref.sha256[0]}.json`;
  const fetchText = vi.fn().mockResolvedValueOnce(first.payload).mockResolvedValueOnce(second.payload);
  const cache = new DescriptionPackCache(fetchText);
  expect(await cache.get({ ...first.ref, pack: name })).toBe(first.text);
  expect(await cache.get({ ...second.ref, pack: name })).toBe(second.text);
  expect(fetchText).toHaveBeenCalledTimes(2);
});

it('still reads legacy immutable bundle references during migration', async () => {
  const f = await fixture();
  const ref = { ...f.ref, pack: `details/${f.ref.sha256.slice(0, 2)}-${f.ref.pack_sha256}.json` };
  expect(await new DescriptionPackCache(async () => f.payload).get(ref)).toBe(f.text);
});
