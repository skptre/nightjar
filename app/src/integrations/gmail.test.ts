import { beforeEach, describe, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import {
  extractSenderDomain,
  extractSubject,
  hasCalendarAttachment,
  detectSignal,
  matchSenderToCompany,
  buildGmailQuery,
  isAfterApplicationDate,
} from './gmail-scan';
import {
  saveSuggestion,
  getPendingSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  getProcessedEmailIds,
  clearAllGmailData,
  loadApplicationCompanies,
} from './gmail-service';
import { SIGNAL_SUGGESTED_STATUS } from './types';
import type { ApplicationCompany, GmailMessageMetadata } from './types';

let db: NightjarDB;

beforeEach(async () => {
  db = await NightjarDB.createInMemory();
});

const STRIPE: ApplicationCompany = {
  postingId: 'post-stripe-1',
  companySlug: 'stripe',
  companyName: 'Stripe',
  domain: 'stripe.com',
  appliedAt: '2026-08-01T00:00:00.000Z',
  status: 'applied',
};

const GOOGLE: ApplicationCompany = {
  postingId: 'post-google-1',
  companySlug: 'google',
  companyName: 'Google',
  domain: 'google.com',
  appliedAt: '2026-08-15T00:00:00.000Z',
  status: 'applied',
};

function makeHeaders(from: string, subject: string): Array<{ name: string; value: string }> {
  return [
    { name: 'From', value: from },
    { name: 'Subject', value: subject },
    { name: 'Date', value: '2026-09-01T12:00:00.000Z' },
  ];
}

function makeMessage(
  overrides: Partial<GmailMessageMetadata> & { from?: string; subject?: string } = {},
): GmailMessageMetadata {
  const from = overrides.from ?? 'recruiter@stripe.com';
  const subject = overrides.subject ?? 'Next steps with your application';
  return {
    id: overrides.id ?? 'msg-001',
    threadId: overrides.threadId ?? 'thread-001',
    snippet: overrides.snippet ?? '',
    internalDate: overrides.internalDate ?? String(new Date('2026-09-01').getTime()),
    payload: overrides.payload ?? {
      headers: makeHeaders(from, subject),
      mimeType: 'multipart/mixed',
      parts: [],
    },
  };
}

describe('extractSenderDomain', () => {
  it('extracts domain from angle-bracket format', () => {
    const headers = makeHeaders('Alice Smith <alice@stripe.com>', 'Hi');
    expect(extractSenderDomain(headers)).toBe('stripe.com');
  });

  it('extracts domain from bare email', () => {
    const headers = makeHeaders('noreply@greenhouse.io', 'Update');
    expect(extractSenderDomain(headers)).toBe('greenhouse.io');
  });

  it('returns null when no From header', () => {
    expect(extractSenderDomain([{ name: 'Subject', value: 'test' }])).toBeNull();
  });

  it('lowercases domain', () => {
    const headers = makeHeaders('hr@STRIPE.COM', 'hi');
    expect(extractSenderDomain(headers)).toBe('stripe.com');
  });
});

describe('extractSubject', () => {
  it('gets subject value', () => {
    const headers = makeHeaders('a@b.com', 'Interview Invitation');
    expect(extractSubject(headers)).toBe('Interview Invitation');
  });

  it('returns empty string when missing', () => {
    expect(extractSubject([{ name: 'From', value: 'a@b.com' }])).toBe('');
  });
});

describe('hasCalendarAttachment', () => {
  it('detects text/calendar MIME type', () => {
    const msg = makeMessage();
    msg.payload.parts = [{ mimeType: 'text/calendar' }];
    expect(hasCalendarAttachment(msg)).toBe(true);
  });

  it('detects .ics filename', () => {
    const msg = makeMessage();
    msg.payload.parts = [{ mimeType: 'application/octet-stream', filename: 'invite.ics' }];
    expect(hasCalendarAttachment(msg)).toBe(true);
  });

  it('returns false with no parts', () => {
    const msg = makeMessage();
    delete msg.payload.parts;
    expect(hasCalendarAttachment(msg)).toBe(false);
  });

  it('returns false for non-calendar parts', () => {
    const msg = makeMessage();
    msg.payload.parts = [{ mimeType: 'text/plain' }, { mimeType: 'text/html' }];
    expect(hasCalendarAttachment(msg)).toBe(false);
  });
});

describe('detectSignal', () => {
  it('detects interview keyword in subject', () => {
    const result = detectSignal('Interview Invitation for SWE Intern', '', false);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('interview');
    expect(result!.confidence).toBe('high');
  });

  it('detects interview keyword in snippet only as medium confidence', () => {
    const result = detectSignal('Update from Stripe', 'schedule your next interview', false);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('interview');
    expect(result!.confidence).toBe('medium');
  });

  it('detects offer signal', () => {
    const result = detectSignal('Congratulations!', 'pleased to offer you the position', false);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('offer');
  });

  it('detects rejection signal', () => {
    const result = detectSignal('Application Update', 'unfortunately we are not moving forward', false);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('rejection');
  });

  it('detects assessment signal', () => {
    const result = detectSignal('Online Assessment', 'complete the hackerrank test', false);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('assessment');
  });

  it('calendar attachment produces high-confidence interview', () => {
    const result = detectSignal('Meeting', '', true);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('interview');
    expect(result!.confidence).toBe('high');
    expect(result!.matchedKeyword).toBe('.ics attachment');
  });

  it('returns null for unrecognized email', () => {
    expect(detectSignal('Your weekly newsletter', 'top stories this week', false)).toBeNull();
  });

  it('assessment takes priority over interview when both match', () => {
    const result = detectSignal('Online Assessment - Technical Interview', '', false);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe('assessment');
  });
});

describe('matchSenderToCompany', () => {
  const companies = [STRIPE, GOOGLE];

  it('matches by direct domain', () => {
    const match = matchSenderToCompany('stripe.com', 'Hello', '', companies);
    expect(match).not.toBeNull();
    expect(match!.companySlug).toBe('stripe');
  });

  it('matches ATS domain by company name in subject', () => {
    const match = matchSenderToCompany('greenhouse.io', 'Your Stripe Application', '', companies);
    expect(match).not.toBeNull();
    expect(match!.companySlug).toBe('stripe');
  });

  it('matches assessment platform domain by company name', () => {
    const match = matchSenderToCompany('hackerrank.com', 'Google Coding Challenge', '', companies);
    expect(match).not.toBeNull();
    expect(match!.companySlug).toBe('google');
  });

  it('returns null for unknown sender', () => {
    expect(matchSenderToCompany('random-newsletter.com', 'News', '', companies)).toBeNull();
  });

  it('matches by domain base against company slug', () => {
    const match2 = matchSenderToCompany('stripe.io', 'Hello', '', [STRIPE]);
    expect(match2).not.toBeNull();
    expect(match2!.companySlug).toBe('stripe');
  });

  it('skips short company names for ATS matching to avoid false positives', () => {
    const shortCo: ApplicationCompany = {
      ...STRIPE,
      companyName: 'AB',
      companySlug: 'ab',
    };
    const match = matchSenderToCompany('greenhouse.io', 'AB Technologies Interview', '', [shortCo]);
    expect(match).toBeNull();
  });
});

describe('buildGmailQuery', () => {
  it('includes company domains and ATS domains', () => {
    const query = buildGmailQuery([STRIPE]);
    expect(query).toContain('from:stripe.com');
    expect(query).toContain('from:greenhouse.io');
    expect(query).toContain('from:hackerrank.com');
  });

  it('adds after: clause based on earliest application', () => {
    const query = buildGmailQuery([STRIPE, GOOGLE]);
    expect(query).toContain('after:2026/08/01');
  });

  it('still includes ATS domains even with no companies', () => {
    const query = buildGmailQuery([]);
    expect(query).toContain('from:greenhouse.io');
    expect(query).toContain('from:hackerrank.com');
  });
});

describe('isAfterApplicationDate', () => {
  it('accepts email after application date', () => {
    expect(isAfterApplicationDate('2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')).toBe(true);
  });

  it('rejects email before application date', () => {
    expect(isAfterApplicationDate('2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')).toBe(false);
  });

  it('accepts when no applied date', () => {
    expect(isAfterApplicationDate('2026-09-01T00:00:00.000Z', '')).toBe(true);
  });
});

describe('gmail_suggestions database operations', () => {
  async function insertTestApplication(postingId = 'post-stripe-1'): Promise<void> {
    const now = '2026-09-01T00:00:00.000Z';
    await db.run(
      `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
      [postingId, JSON.stringify({
        id: postingId,
        company: 'Stripe',
        company_slug: 'stripe',
        url: 'https://stripe.com/jobs/1',
      }), now],
    );
    await db.run(
      `INSERT INTO applications (posting_id, status, applied_at, created_at, updated_at)
       VALUES (?, 'applied', ?, ?, ?)`,
      [postingId, now, now, now],
    );
  }

  describe('saveSuggestion', () => {
    it('inserts a new suggestion', async () => {
      await insertTestApplication();
      await saveSuggestion(db, {
        emailId: 'email-001',
        signalType: 'interview',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'Interview Invitation',
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending',
      });

      const pending = await getPendingSuggestions(db);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.signalType).toBe('interview');
      expect(pending[0]!.companyName).toBe('Stripe');
    });

    it('deduplicates by email_id', async () => {
      await insertTestApplication();
      const suggestion = {
        emailId: 'email-dup',
        signalType: 'interview' as const,
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'Interview',
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending' as const,
      };

      await saveSuggestion(db, suggestion);
      await saveSuggestion(db, suggestion);

      const pending = await getPendingSuggestions(db);
      expect(pending).toHaveLength(1);
    });

    it('truncates long subjects', async () => {
      await insertTestApplication();
      const longSubject = 'A'.repeat(300);
      await saveSuggestion(db, {
        emailId: 'email-long',
        signalType: 'interview',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: longSubject,
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending',
      });

      const pending = await getPendingSuggestions(db);
      expect(pending[0]!.subject.length).toBeLessThanOrEqual(200);
    });
  });

  describe('getProcessedEmailIds', () => {
    it('returns set of all processed email IDs', async () => {
      await insertTestApplication();
      await saveSuggestion(db, {
        emailId: 'email-a',
        signalType: 'interview',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'A',
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending',
      });
      await saveSuggestion(db, {
        emailId: 'email-b',
        signalType: 'rejection',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'B',
        receivedAt: '2026-09-02T12:00:00.000Z',
        status: 'pending',
      });

      const ids = await getProcessedEmailIds(db);
      expect(ids.size).toBe(2);
      expect(ids.has('email-a')).toBe(true);
      expect(ids.has('email-b')).toBe(true);
    });
  });

  describe('acceptSuggestion', () => {
    it('updates suggestion status and application status', async () => {
      await insertTestApplication();
      await saveSuggestion(db, {
        emailId: 'email-accept',
        signalType: 'interview',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'Interview',
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending',
      });

      const pending = await getPendingSuggestions(db);
      expect(pending).toHaveLength(1);

      const suggestedStatus = SIGNAL_SUGGESTED_STATUS['interview'];
      await acceptSuggestion(db, pending[0]!.id, suggestedStatus);

      const afterAccept = await getPendingSuggestions(db);
      expect(afterAccept).toHaveLength(0);

      const app = await db.queryOne<{ status: string }>(
        'SELECT status FROM applications WHERE posting_id = ?',
        ['post-stripe-1'],
      );
      expect(app!.status).toBe('phone');
    });

    it('no-ops for nonexistent suggestion', async () => {
      await acceptSuggestion(db, 'nonexistent-id', 'phone');
    });
  });

  describe('dismissSuggestion', () => {
    it('marks suggestion as dismissed and removes from pending', async () => {
      await insertTestApplication();
      await saveSuggestion(db, {
        emailId: 'email-dismiss',
        signalType: 'rejection',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'Update',
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending',
      });

      const pending = await getPendingSuggestions(db);
      await dismissSuggestion(db, pending[0]!.id);

      const afterDismiss = await getPendingSuggestions(db);
      expect(afterDismiss).toHaveLength(0);

      const ids = await getProcessedEmailIds(db);
      expect(ids.has('email-dismiss')).toBe(true);
    });
  });

  describe('clearAllGmailData', () => {
    it('removes all suggestions', async () => {
      await insertTestApplication();
      await saveSuggestion(db, {
        emailId: 'email-clear-1',
        signalType: 'interview',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'A',
        receivedAt: '2026-09-01T12:00:00.000Z',
        status: 'pending',
      });
      await saveSuggestion(db, {
        emailId: 'email-clear-2',
        signalType: 'offer',
        companySlug: 'stripe',
        companyName: 'Stripe',
        postingId: 'post-stripe-1',
        senderDomain: 'stripe.com',
        subject: 'B',
        receivedAt: '2026-09-02T12:00:00.000Z',
        status: 'pending',
      });

      await clearAllGmailData(db);
      const pending = await getPendingSuggestions(db);
      expect(pending).toHaveLength(0);
    });
  });

  describe('loadApplicationCompanies', () => {
    it('loads companies from joined applications and postings', async () => {
      await insertTestApplication('post-stripe-1');
      const companies = await loadApplicationCompanies(db);
      expect(companies).toHaveLength(1);
      expect(companies[0]!.companySlug).toBe('stripe');
      expect(companies[0]!.domain).toBe('stripe.com');
    });

    it('excludes applications with non-active statuses', async () => {
      await insertTestApplication('post-new');
      await db.run(
        `UPDATE applications SET status = 'new' WHERE posting_id = ?`,
        ['post-new'],
      );
      const companies = await loadApplicationCompanies(db);
      expect(companies).toHaveLength(0);
    });
  });
});

describe('signal type to status mapping', () => {
  it('maps interview to phone', () => {
    expect(SIGNAL_SUGGESTED_STATUS['interview']).toBe('phone');
  });

  it('maps offer to offer', () => {
    expect(SIGNAL_SUGGESTED_STATUS['offer']).toBe('offer');
  });

  it('maps rejection to rejected', () => {
    expect(SIGNAL_SUGGESTED_STATUS['rejection']).toBe('rejected');
  });

  it('maps assessment to oa', () => {
    expect(SIGNAL_SUGGESTED_STATUS['assessment']).toBe('oa');
  });
});

describe('end-to-end scan scenarios', () => {
  async function insertTestApplication(postingId: string, company: string, domain: string, appliedAt: string): Promise<void> {
    const now = '2026-09-01T00:00:00.000Z';
    await db.run(
      `INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)`,
      [postingId, JSON.stringify({
        id: postingId,
        company,
        company_slug: company.toLowerCase().replace(/\s+/g, '-'),
        url: `https://${domain}/jobs/1`,
      }), now],
    );
    await db.run(
      `INSERT INTO applications (posting_id, status, applied_at, created_at, updated_at)
       VALUES (?, 'applied', ?, ?, ?)`,
      [postingId, appliedAt, now, now],
    );
  }

  it('processes email from applied company with interview signal', async () => {
    await insertTestApplication('p1', 'Stripe', 'stripe.com', '2026-08-01T00:00:00.000Z');
    const companies = await loadApplicationCompanies(db);
    const senderDomain = extractSenderDomain(makeHeaders('recruiter@stripe.com', 'Interview'));
    expect(senderDomain).toBe('stripe.com');

    const matched = matchSenderToCompany(senderDomain!, 'Interview Invitation', '', companies);
    expect(matched).not.toBeNull();

    const signal = detectSignal('Interview Invitation', '', false);
    expect(signal).not.toBeNull();
    expect(signal!.signalType).toBe('interview');

    await saveSuggestion(db, {
      emailId: 'e2e-email-1',
      signalType: signal!.signalType,
      companySlug: matched!.companySlug,
      companyName: matched!.companyName,
      postingId: matched!.postingId,
      senderDomain: senderDomain!,
      subject: 'Interview Invitation',
      receivedAt: '2026-09-01T12:00:00.000Z',
      status: 'pending',
    });

    const pending = await getPendingSuggestions(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.signalType).toBe('interview');
  });

  it('rejects email received before application date', async () => {
    await insertTestApplication('p2', 'Google', 'google.com', '2026-09-01T00:00:00.000Z');
    const emailDate = '2026-08-15T00:00:00.000Z';
    expect(isAfterApplicationDate(emailDate, '2026-09-01T00:00:00.000Z')).toBe(false);
  });

  it('accept updates application and clears suggestion', async () => {
    await insertTestApplication('p3', 'Stripe', 'stripe.com', '2026-08-01T00:00:00.000Z');
    await saveSuggestion(db, {
      emailId: 'e2e-accept',
      signalType: 'offer',
      companySlug: 'stripe',
      companyName: 'Stripe',
      postingId: 'p3',
      senderDomain: 'stripe.com',
      subject: 'Congratulations!',
      receivedAt: '2026-09-01T12:00:00.000Z',
      status: 'pending',
    });

    const pending = await getPendingSuggestions(db);
    await acceptSuggestion(db, pending[0]!.id, SIGNAL_SUGGESTED_STATUS['offer']);

    const app = await db.queryOne<{ status: string }>(
      'SELECT status FROM applications WHERE posting_id = ?',
      ['p3'],
    );
    expect(app!.status).toBe('offer');

    const remaining = await getPendingSuggestions(db);
    expect(remaining).toHaveLength(0);
  });

  it('dismissed suggestion stays in processedIds to prevent reappearance', async () => {
    await insertTestApplication('p4', 'Stripe', 'stripe.com', '2026-08-01T00:00:00.000Z');
    await saveSuggestion(db, {
      emailId: 'e2e-dismiss',
      signalType: 'rejection',
      companySlug: 'stripe',
      companyName: 'Stripe',
      postingId: 'p4',
      senderDomain: 'stripe.com',
      subject: 'Unfortunately',
      receivedAt: '2026-09-01T12:00:00.000Z',
      status: 'pending',
    });

    const pending = await getPendingSuggestions(db);
    await dismissSuggestion(db, pending[0]!.id);

    const processedIds = await getProcessedEmailIds(db);
    expect(processedIds.has('e2e-dismiss')).toBe(true);

    const pendingAfter = await getPendingSuggestions(db);
    expect(pendingAfter).toHaveLength(0);
  });

  it('multiple signals from same company: each gets own suggestion', async () => {
    await insertTestApplication('p5', 'Stripe', 'stripe.com', '2026-08-01T00:00:00.000Z');

    await saveSuggestion(db, {
      emailId: 'multi-1',
      signalType: 'assessment',
      companySlug: 'stripe',
      companyName: 'Stripe',
      postingId: 'p5',
      senderDomain: 'stripe.com',
      subject: 'Online Assessment',
      receivedAt: '2026-09-01T12:00:00.000Z',
      status: 'pending',
    });

    await saveSuggestion(db, {
      emailId: 'multi-2',
      signalType: 'interview',
      companySlug: 'stripe',
      companyName: 'Stripe',
      postingId: 'p5',
      senderDomain: 'stripe.com',
      subject: 'Interview Scheduled',
      receivedAt: '2026-09-03T12:00:00.000Z',
      status: 'pending',
    });

    const pending = await getPendingSuggestions(db);
    expect(pending).toHaveLength(2);
    expect(pending[0]!.receivedAt > pending[1]!.receivedAt).toBe(true);
  });
});
