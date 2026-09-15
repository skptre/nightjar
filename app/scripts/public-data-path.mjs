import path from 'node:path';
export function publicDataPath(root, requestUrl) {
  if (!requestUrl.startsWith('/data/')) return null;
  let relative;
  try { relative = decodeURIComponent(requestUrl.split(/[?#]/,1)[0].slice(6)); }
  catch { return null; }
  if (!relative || relative.includes('\0')) return null;
  const resolved = path.resolve(root,relative);
  const inside = path.relative(root,resolved);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? resolved : null;
}
