import type { Database } from '@/db/database';
import { readWatchlist } from '@/hooks/useWatchlist';
export async function notifyWatchedJobs(db: Database, ids: string[]): Promise<void> {
  if (localStorage.getItem('nightjar_watch_alerts') !== 'true' || !('Notification' in globalThis)
    || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const watched = new Set(readWatchlist().map(company => company.slug));
  if (!watched.size) return;
  let seen: string[] = [];
  try { const value: unknown = JSON.parse(localStorage.getItem('nightjar_watch_alert_seen') ?? '[]');
    if (Array.isArray(value)) seen = value.filter((id): id is string => typeof id === 'string');
  } catch { /* No previous notifications. */ }
  const matching: string[] = [];
  const companies = new Set<string>();
  for (const id of new Set(ids)) {
    if (seen.includes(id)) continue;
    const row = await db.queryOne<{ data: string; closed_at: string | null }>('SELECT data,closed_at FROM postings_cache WHERE id=?', [id]);
    if (!row || row.closed_at) continue;
    try { const data = JSON.parse(row.data) as Record<string, string>;
      if (data.company_slug && watched.has(data.company_slug)) { matching.push(id); companies.add(data.company ?? data.company_slug); }
    } catch { /* Malformed postings do not notify. */ }
  }
  if (!matching.length) return;
  try {
    const notice = new Notification('Nightjar', { body: `${matching.length} new ${matching.length === 1 ? 'role' : 'roles'} at ${[...companies].slice(0, 2).join(' and ')}${companies.size > 2 ? ` + ${companies.size - 2} more companies` : ''}`,
      tag: 'nightjar-watched-roles' });
    notice.onclick = () => { window.focus(); notice.close(); };
    localStorage.setItem('nightjar_watch_alert_seen', JSON.stringify([...seen, ...matching].slice(-2000)));
  } catch { /* Notification failure must never fail job collection. */ }
}
