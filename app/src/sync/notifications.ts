import type { NightjarDB } from '@/db/database';

const NOTIFICATION_CAP = 15;

interface PostingSummary {
  id: string;
  title: string;
  company: string;
  location: string;
}

export function getNewPostingSummaries(
  db: NightjarDB,
  postingIds: string[],
): PostingSummary[] {
  if (postingIds.length === 0) return [];

  const summaries: PostingSummary[] = [];
  for (const id of postingIds) {
    const row = db.queryOne<{ data: string; eligibility: string | null }>(
      'SELECT data, eligibility FROM postings_cache WHERE id = ?',
      [id],
    );
    if (!row) continue;

    if (row.eligibility) {
      try {
        const parsed: unknown = JSON.parse(row.eligibility);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as Record<string, unknown>)['verdict'] === 'ineligible'
        ) {
          continue;
        }
      } catch {
        // malformed eligibility JSON — treat as unclear (notifiable)
      }
    }

    try {
      const posting = JSON.parse(row.data) as Record<string, unknown>;
      summaries.push({
        id,
        title: (posting['title'] as string) ?? 'Unknown',
        company: (posting['company'] as string) ?? 'Unknown',
        location: (posting['location'] as string) ?? '',
      });
    } catch {
      // malformed posting data — skip
    }
  }

  return summaries;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in globalThis)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

export async function fireNewPostingNotifications(
  db: NightjarDB,
  newPostingIds: string[],
): Promise<number> {
  const summaries = getNewPostingSummaries(db, newPostingIds);
  if (summaries.length === 0) return 0;

  if (!('Notification' in globalThis) || Notification.permission !== 'granted') {
    return summaries.length;
  }

  if (summaries.length > NOTIFICATION_CAP) {
    new Notification('Nightjar', {
      body: `${String(summaries.length)} new postings — open Nightjar to triage`,
      tag: 'nightjar-batch',
    });
    return summaries.length;
  }

  for (const posting of summaries) {
    const body = posting.location
      ? `${posting.company} • ${posting.location}`
      : posting.company;
    new Notification(posting.title, {
      body,
      tag: `nightjar-${posting.id}`,
    });
  }

  return summaries.length;
}
