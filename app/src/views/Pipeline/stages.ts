import type { PipelineStatus } from '@/outcomes/types';

// Each stored status keeps its own label; colors follow the six tracker stages
// (Saved, Applied, Assessment, Interviewing, Offer, Closed).
export type StageTone = 'saved' | 'applied' | 'assess' | 'interview' | 'offer' | 'closed';
export interface StageMeta { value: PipelineStatus; label: string; tone: StageTone }

export const STAGES: readonly StageMeta[] = [
  { value: 'saved', label: 'Saved', tone: 'saved' },
  { value: 'applied', label: 'Applied', tone: 'applied' },
  { value: 'oa', label: 'Assessment', tone: 'assess' },
  { value: 'phone', label: 'Phone interview', tone: 'interview' },
  { value: 'onsite', label: 'Final interview', tone: 'interview' },
  { value: 'offer', label: 'Offer', tone: 'offer' },
  { value: 'rejected', label: 'Rejected', tone: 'closed' },
  { value: 'ghosted', label: 'No response', tone: 'closed' },
];

export const TONE_DOT: Record<StageTone, string> = {
  saved: 'rgba(var(--fg-rgb),.35)', applied: 'var(--st-applied)', assess: 'var(--st-assess)',
  interview: 'var(--st-interview)', offer: 'var(--st-offer)', closed: 'rgba(var(--fg-rgb),.22)',
};

export function stageOf(status: string): StageMeta {
  return STAGES.find(stage => stage.value === status) ?? STAGES[0]!;
}

/** Stage dot as it reads on the inverted toast (neutral stages blend into the pill). */
export function toastDot(status: string): string {
  const tone = stageOf(status).tone;
  return tone === 'saved' || tone === 'closed' ? 'color-mix(in srgb, var(--bg) 45%, var(--fg))' : TONE_DOT[tone];
}

/** A stored due value ("2026-10-03" or a full ISO time) as a local date at noon. */
export function dueDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T12:00:00`);
}

function days(value: string): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
  return Math.round((dueDate(value).getTime() - today) / 86400000);
}

export function shortDate(value: string): string {
  return dueDate(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "In 2 days · Oct 3", "Tomorrow · Oct 2", "3 days ago · Sep 28". Hot when it's close or late. */
export function relativeDue(value: string): { label: string; rel: string; hot: boolean } {
  const d = days(value);
  const rel = d < -1 ? `${String(-d)} days ago` : d === -1 ? 'Yesterday' : d === 0 ? 'Today' : d === 1 ? 'Tomorrow'
    : d < 7 ? `In ${String(d)} days` : d < 14 ? 'In 1 week' : `In ${String(Math.round(d / 7))} weeks`;
  return { label: `${rel} · ${shortDate(value)}`, rel, hot: d <= 3 };
}
