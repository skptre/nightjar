import type {
  ApplicationCompany,
  DetectedSignal,
  GmailSignalType,
  GmailMessageMetadata,
  GmailMessageListResponse,
} from './types';

const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

const INTERVIEW_KEYWORDS = [
  'interview',
  'schedule',
  'next steps',
  'meet the team',
  'technical screen',
  'phone screen',
  'virtual onsite',
  'coding challenge',
  'take-home',
  'final round',
  'behavioral interview',
  'panel interview',
  'case study',
  'superday',
  'super day',
];

const OFFER_KEYWORDS = [
  'offer letter',
  'congratulations',
  'pleased to offer',
  'offer of employment',
  'compensation',
  'start date',
  'welcome aboard',
  'excited to extend',
];

const REJECTION_KEYWORDS = [
  'unfortunately',
  'not moving forward',
  'other candidates',
  'not selected',
  'after careful consideration',
  'position has been filled',
  'will not be moving forward',
  'decided not to proceed',
  'regret to inform',
  'unable to offer',
];

const ASSESSMENT_KEYWORDS = [
  'online assessment',
  'coding assessment',
  'hackerrank',
  'codesignal',
  'codility',
  'complete the following',
  'technical assessment',
  'take-home assignment',
  'skills assessment',
  'oa link',
  'oa invitation',
];

const ATS_DOMAINS = new Set([
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'smartrecruiters.com',
  'hire.lever.co',
  'boards.greenhouse.io',
  'app.ashbyhq.com',
  'icims.com',
  'taleo.net',
  'jobvite.com',
  'breezy.hr',
  'workable.com',
  'bamboohr.com',
  'jazz.co',
  'teamtailor.com',
  'pinpointhq.com',
  'recruitee.com',
  'comeet.com',
  'goodtime.io',
  'calendly.com',
  'modernhire.com',
  'hirevue.com',
]);

const ASSESSMENT_PLATFORM_DOMAINS = new Set([
  'hackerrank.com',
  'codesignal.com',
  'codility.com',
  'qualified.io',
  'devskiller.com',
  'codingame.com',
  'karat.com',
  'byteboard.dev',
  'triplebyte.com',
  'codescreen.com',
]);

interface SignalRule {
  type: GmailSignalType;
  keywords: string[];
}

const SIGNAL_RULES: SignalRule[] = [
  { type: 'assessment', keywords: ASSESSMENT_KEYWORDS },
  { type: 'offer', keywords: OFFER_KEYWORDS },
  { type: 'rejection', keywords: REJECTION_KEYWORDS },
  { type: 'interview', keywords: INTERVIEW_KEYWORDS },
];

export function extractSenderDomain(headers: Array<{ name: string; value: string }>): string | null {
  const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value;
  if (!from) return null;
  const angleMatch = /<[^@]+@([^>]+)>/.exec(from);
  if (angleMatch?.[1]) return angleMatch[1].toLowerCase();
  const bareMatch = /[\w.+-]+@([\w.-]+)/.exec(from);
  if (bareMatch?.[1]) return bareMatch[1].toLowerCase();
  return null;
}

export function extractSubject(headers: Array<{ name: string; value: string }>): string {
  return headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
}

export function hasCalendarAttachment(message: GmailMessageMetadata): boolean {
  if (!message.payload.parts) return false;
  return message.payload.parts.some(
    (part) =>
      part.mimeType === 'text/calendar' ||
      part.mimeType === 'application/ics' ||
      (part.filename != null && part.filename.endsWith('.ics')),
  );
}

export function detectSignal(subject: string, snippet: string, hasIcs: boolean): DetectedSignal | null {
  const text = `${subject} ${snippet}`.toLowerCase();

  if (hasIcs) {
    return { signalType: 'interview', confidence: 'high', matchedKeyword: '.ics attachment' };
  }

  for (const rule of SIGNAL_RULES) {
    for (const keyword of rule.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        const confidence = subject.toLowerCase().includes(keyword.toLowerCase()) ? 'high' : 'medium';
        return { signalType: rule.type, confidence, matchedKeyword: keyword };
      }
    }
  }

  return null;
}

export function matchSenderToCompany(
  senderDomain: string,
  subject: string,
  snippet: string,
  companies: ApplicationCompany[],
): ApplicationCompany | null {
  for (const company of companies) {
    if (company.domain && senderDomain === company.domain.toLowerCase()) {
      return company;
    }
  }

  const isAtsDomain = ATS_DOMAINS.has(senderDomain) || ASSESSMENT_PLATFORM_DOMAINS.has(senderDomain);
  if (isAtsDomain) {
    const text = `${subject} ${snippet}`.toLowerCase();
    for (const company of companies) {
      if (company.companyName.length >= 3 && text.includes(company.companyName.toLowerCase())) {
        return company;
      }
    }
  }

  const domainParts = senderDomain.split('.');
  const domainBase = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : domainParts[0];
  if (domainBase && domainBase.length >= 3) {
    for (const company of companies) {
      if (company.companySlug === domainBase || company.companyName.toLowerCase() === domainBase) {
        return company;
      }
    }
  }

  return null;
}

export function buildGmailQuery(companies: ApplicationCompany[]): string {
  const domains = new Set<string>();
  for (const company of companies) {
    if (company.domain) {
      domains.add(company.domain);
    }
  }

  for (const atsDomain of ATS_DOMAINS) {
    domains.add(atsDomain);
  }
  for (const platform of ASSESSMENT_PLATFORM_DOMAINS) {
    domains.add(platform);
  }

  const domainClauses = [...domains].map((d) => `from:${d}`);

  if (domainClauses.length === 0) return '';

  const earliest = companies.reduce((min, c) => {
    if (!c.appliedAt) return min;
    return min && min < c.appliedAt ? min : c.appliedAt;
  }, '' as string);

  let query = `{${domainClauses.join(' ')}}`;
  if (earliest) {
    const dateStr = earliest.slice(0, 10).replace(/-/g, '/');
    query += ` after:${dateStr}`;
  }

  return query;
}

export async function fetchMessageList(
  accessToken: string,
  query: string,
  maxResults: number = 50,
): Promise<GmailMessageListResponse> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });

  const response = await fetch(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Gmail token expired');
    }
    throw new Error(`Gmail API error: ${String(response.status)}`);
  }

  return response.json() as Promise<GmailMessageListResponse>;
}

export async function fetchMessageMetadata(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageMetadata> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${messageId}`);
  url.searchParams.set('format', 'metadata');
  url.searchParams.append('metadataHeaders', 'From');
  url.searchParams.append('metadataHeaders', 'Subject');
  url.searchParams.append('metadataHeaders', 'Date');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Gmail token expired');
    }
    throw new Error(`Gmail API error: ${String(response.status)}`);
  }

  return response.json() as Promise<GmailMessageMetadata>;
}

export function isAfterApplicationDate(
  emailDate: string,
  appliedAt: string,
): boolean {
  if (!appliedAt) return true;
  const emailTime = new Date(emailDate).getTime();
  const appliedTime = new Date(appliedAt).getTime();
  return emailTime >= appliedTime;
}
