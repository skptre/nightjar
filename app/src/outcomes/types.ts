export const PIPELINE_STATUSES = [
  'saved',
  'applied',
  'oa',
  'phone',
  'onsite',
  'offer',
  'rejected',
  'ghosted',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export type ApplicationStatus = PipelineStatus | 'new' | 'skipped';

export function isApplicationStatus(status: string): status is ApplicationStatus {
  return status === 'new' || status === 'skipped'
    || (PIPELINE_STATUSES as readonly string[]).includes(status);
}

export const APPLICATION_OUTCOMES = [
  'interview',
  'offer',
  'rejection',
  'ghosted',
  'withdrawn',
] as const;

export type ApplicationOutcome = (typeof APPLICATION_OUTCOMES)[number];
export type SuggestionDecision = 'applied' | 'dismissed';

export interface OutcomeDetails {
  notes?: string | null;
  interviewRounds?: number | null;
}

export interface OutcomeEvent {
  outcome: ApplicationOutcome;
  occurredAt: string;
  interviewRounds: number;
  notes: string | null;
}

export function outcomeForStatus(status: string): ApplicationOutcome | null {
  if (status === 'phone' || status === 'onsite') return 'interview';
  if (status === 'offer') return 'offer';
  if (status === 'rejected') return 'rejection';
  if (status === 'ghosted') return 'ghosted';
  return null;
}

export function statusNeedsOutcomePrompt(status: string): boolean {
  return outcomeForStatus(status) !== null;
}
