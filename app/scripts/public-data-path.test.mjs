import { expect,it } from 'vitest';
import path from 'node:path';
import { publicDataPath } from './public-data-path.mjs';
const root = path.resolve('data');
it('serves public data with cache query parameters', () => {
  expect(publicDataPath(root,'/data/feed.json?v=2')).toBe(path.join(root,'feed.json'));
});
it.each(['/data/../private','/data/%2e%2e/private','/data/%2fprivate','/data/%00','/data/%','/other/feed.json'])('rejects escaping or invalid path %s', url => {
  expect(publicDataPath(root,url)).toBeNull();
});
