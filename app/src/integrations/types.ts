export const GMAIL_SIGNAL_TYPES = [
  'interview',
  'offer',
  'rejection',
  'assessment',
] as const;

export type GmailSignalType = (typeof GMAIL_SIGNAL_TYPES)[number];

export interface GmailSuggestion {
  id: string;
  emailId: string;
  signalType: GmailSignalType;
  companySlug: string;
  companyName: string;
  postingId: string;
  senderDomain: string;
  subject: string;
  receivedAt: string;
  status: 'pending' | 'accepted' | 'dismissed';
  createdAt: string;
}

export interface GmailAuthState {
  connected: boolean;
  email: string | null;
  lastScanAt: string | null;
  error: string | null;
}

export interface GmailTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface GmailScanConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export const DEFAULT_SCAN_CONFIG: GmailScanConfig = {
  enabled: true,
  intervalMinutes: 15,
};

export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  payload: {
    headers: GmailMessageHeader[];
    mimeType: string;
    parts?: Array<{ mimeType: string; filename?: string }>;
  };
}

export interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface ApplicationCompany {
  postingId: string;
  companySlug: string;
  companyName: string;
  domain: string;
  appliedAt: string;
  status: string;
}

export interface DetectedSignal {
  signalType: GmailSignalType;
  confidence: 'high' | 'medium';
  matchedKeyword: string;
}

export const SIGNAL_SUGGESTED_STATUS: Record<GmailSignalType, string> = {
  interview: 'phone',
  offer: 'offer',
  rejection: 'rejected',
  assessment: 'oa',
};

export function signalTypeLabel(type: GmailSignalType): string {
  switch (type) {
    case 'interview': return 'Interview Invite';
    case 'offer': return 'Offer';
    case 'rejection': return 'Rejection';
    case 'assessment': return 'Online Assessment';
  }
}
