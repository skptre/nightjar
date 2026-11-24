import fs from 'node:fs';
import path from 'node:path';

export function bundlePublicFeed(source, output) {
  const meta = JSON.parse(fs.readFileSync(path.join(source, 'meta.json'), 'utf8'));
  const files = new Set(['meta.json']);
  if (!meta.sharded) files.add('feed.json');
  else {
    for (const [id, info] of Object.entries(meta.shards)) {
      const relative = info.path ?? `${id}.json`;
      if (!/^(?:[a-z_-]+|snapshots\/[a-f0-9]{64})\.json$/.test(relative)) {
        throw new Error('Invalid bundled shard path');
      }
      files.add(`feed/${relative}`);
      const shard = JSON.parse(fs.readFileSync(path.join(source, 'feed', relative), 'utf8'));
      for (const row of Object.values(shard.postings)) {
        if (!row.description_ref) continue;
        const pack = row.description_ref.pack;
        if (!/^details\/(?:descriptions-[a-f0-9]|[a-f0-9]{2}-[a-f0-9]{64})\.json$/.test(pack)) {
          throw new Error('Invalid bundled description path');
        }
        files.add(`feed/${pack}`);
      }
    }
  }
  for (const relative of files) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
  return files.size;
}
