import type { Database } from '@/db/types';
import type { ApplicationCompany, GmailSuggestion } from './types';
import { getAccessToken, isGmailConnected, setLastScanAt } from './gmail-auth';
import {
  buildGmailQuery,
  detectSignal,
  extractSenderDomain,
  extractSubject,
  fetchMessageList,
  fetchMessageMetadata,
  hasCalendarAttachment,
  isAfterApplicationDate,
  matchSenderToCompany,
} from './gmail-scan';

export async function loadApplicationCompanies(db: Database): Promise<ApplicationCompany[]> {
  const rows = await db.query<{
    posting_id: string;
    status: string;
    applied_at: string | null;
    data: string;
  }>(
    `SELECT a.posting_id, a.status, a.applied_at, p.data
     FROM applications a
     JOIN postings_cache p ON a.posting_id = p.id
     WHERE a.status IN ('applied', 'oa', 'phone', 'onsite')`,
  );

  const companies: ApplicationCompany[] = [];
  for (const row of rows) {
    try {
      const posting = JSON.parse(row.data) as {
        company?: string;
        company_slug?: string;
        url?: string;
      };

      let domain = '';
      if (posting.company_slug) {
        domain = `${posting.company_slug}.com`;
      }

      companies.push({
        postingId: row.posting_id,
        companySlug: posting.company_slug ?? '',
        companyName: posting.company ?? '',
        domain,
        appliedAt: row.applied_at ?? '',
        status: row.status,
      });
    } catch {
      continue;
    }
  }

  return companies;
}

export async function getProcessedEmailIds(db: Database): Promise<Set<string>> {
  const rows = await db.query<{ email_id: string }>(
    'SELECT email_id FROM gmail_suggestions',
  );
  return new Set(rows.map((r) => r.email_id));
}

export async function saveSuggestion(
  db: Database,
  suggestion: Omit<GmailSuggestion, 'id' | 'createdAt'>,
): Promise<void> {
  const id = `gmail_${suggestion.emailId}_${suggestion.postingId}`;
  const createdAt = new Date().toISOString();

  await db.run(
    `INSERT OR IGNORE INTO gmail_suggestions
     (id, email_id, signal_type, company_slug, company_name, posting_id,
      sender_domain, subject, received_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      suggestion.emailId,
      suggestion.signalType,
      suggestion.companySlug,
      suggestion.companyName,
      suggestion.postingId,
      suggestion.senderDomain,
      suggestion.subject.slice(0, 200),
      suggestion.receivedAt,
      createdAt,
    ],
  );
}

export async function getPendingSuggestions(db: Database): Promise<GmailSuggestion[]> {
  return db.query<GmailSuggestion>(
    `SELECT id, email_id AS emailId, signal_type AS signalType,
            company_slug AS companySlug, company_name AS companyName,
            posting_id AS postingId, sender_domain AS senderDomain,
            subject, received_at AS receivedAt, status, created_at AS createdAt
     FROM gmail_suggestions
     WHERE status = 'pending'
     ORDER BY received_at DESC`,
  );
}

export async function acceptSuggestion(
  db: Database,
  suggestionId: string,
  newStatus: string,
): Promise<void> {
  const suggestion = await db.queryOne<{
    posting_id: string;
    signal_type: string;
  }>(
    'SELECT posting_id, signal_type FROM gmail_suggestions WHERE id = ?',
    [suggestionId],
  );
  if (!suggestion) return;

  const now = new Date().toISOString();
  const outcomeMap: Record<string, string> = {
    interview: 'interview',
    offer: 'offer',
    rejection: 'rejection',
    assessment: 'interview',
  };
  const outcome = outcomeMap[suggestion.signal_type];

  await db.transaction(async (transaction) => {
    await transaction.run(
      `UPDATE gmail_suggestions SET status = 'accepted' WHERE id = ?`,
      [suggestionId],
    );
    await transaction.run(
      `UPDATE applications SET status = ?, updated_at = ? WHERE posting_id = ?`,
      [newStatus, now, suggestion.posting_id],
    );
    if (outcome) {
      await transaction.run(
        `INSERT INTO application_outcome_events
         (posting_id, outcome, occurred_at, interview_rounds, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [suggestion.posting_id, outcome, now, 0, 'Detected via Gmail scan'],
      );
    }
  });
}

export async function dismissSuggestion(
  db: Database,
  suggestionId: string,
): Promise<void> {
  await db.run(
    `UPDATE gmail_suggestions SET status = 'dismissed' WHERE id = ?`,
    [suggestionId],
  );
}

export async function clearAllGmailData(db: Database): Promise<void> {
  await db.run('DELETE FROM gmail_suggestions');
}

export async function runGmailScan(db: Database): Promise<number> {
  const connected = await isGmailConnected();
  if (!connected) return 0;

  const companies = await loadApplicationCompanies(db);
  if (companies.length === 0) return 0;

  const query = buildGmailQuery(companies);
  if (!query) return 0;

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch {
    return 0;
  }

  const processedIds = await getProcessedEmailIds(db);

  let listResponse;
  try {
    listResponse = await fetchMessageList(accessToken, query);
  } catch {
    return 0;
  }

  if (!listResponse.messages || listResponse.messages.length === 0) {
    setLastScanAt(new Date().toISOString());
    return 0;
  }

  let newSuggestions = 0;

  for (const msg of listResponse.messages) {
    if (processedIds.has(msg.id)) continue;

    let metadata;
    try {
      metadata = await fetchMessageMetadata(accessToken, msg.id);
    } catch {
      continue;
    }

    const senderDomain = extractSenderDomain(metadata.payload.headers);
    if (!senderDomain) continue;

    const subject = extractSubject(metadata.payload.headers);
    const snippet = metadata.snippet;

    const matchedCompany = matchSenderToCompany(senderDomain, subject, snippet, companies);
    if (!matchedCompany) continue;

    const emailDate = new Date(Number(metadata.internalDate)).toISOString();
    if (!isAfterApplicationDate(emailDate, matchedCompany.appliedAt)) continue;

    const hasIcs = hasCalendarAttachment(metadata);
    const signal = detectSignal(subject, snippet, hasIcs);
    if (!signal) continue;

    await saveSuggestion(db, {
      emailId: msg.id,
      signalType: signal.signalType,
      companySlug: matchedCompany.companySlug,
      companyName: matchedCompany.companyName,
      postingId: matchedCompany.postingId,
      senderDomain,
      subject,
      receivedAt: emailDate,
      status: 'pending',
    });

    newSuggestions++;
  }

  setLastScanAt(new Date().toISOString());
  return newSuggestions;
}
