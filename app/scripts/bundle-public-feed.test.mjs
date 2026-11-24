import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { bundlePublicFeed } from './bundle-public-feed.mjs';

it('bundles only the current sharded feed and its referenced documents', () => {
  const root = path.resolve('../.tmp');
  const output = fs.mkdtempSync(path.join(root, 'bundle-test-'));
  try {
    const source = path.resolve('../data');
    const count = bundlePublicFeed(source, output);
    const meta = JSON.parse(fs.readFileSync(path.join(output, 'meta.json'), 'utf8'));
    expect(count).toBeGreaterThan(Object.keys(meta.shards).length);
    expect(fs.existsSync(path.join(output, 'feed.json'))).toBe(false);
    expect(fs.existsSync(path.join(output, 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(output, 'feed', '.pack-retention'))).toBe(false);
    for (const [id, info] of Object.entries(meta.shards)) {
      const shard = JSON.parse(fs.readFileSync(path.join(output, 'feed', info.path ?? `${id}.json`), 'utf8'));
      expect(Object.keys(shard.postings)).toHaveLength(info.count);
      for (const posting of Object.values(shard.postings)) {
        if (posting.description_ref) expect(fs.existsSync(path.join(output, 'feed', posting.description_ref.pack))).toBe(true);
      }
    }
  } finally {
    if (!output.startsWith(root + path.sep)) throw new Error('Unexpected temporary directory');
    fs.rmSync(output, { recursive: true });
  }
}, 30000);
