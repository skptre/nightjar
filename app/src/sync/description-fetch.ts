import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import { recomputePosting } from '@/classify/recompute';

const MAX_CONCURRENT = 3;
const MIN_HOST_DELAY_MS = 500;
const PLAINTEXT_CAP = 5000;
const DEFAULT_PREFETCH_LIMIT = 50;

interface PostingInfo {
  id: string;
  url: string;
  source: string;
  source_job_id: string;
  company_slug: string;
  ats?: string;
}

export interface DescriptionResult {
  id: string;
  description: string | null;
  error: string | null;
}

export function parseGreenhouseUrl(url: string): { token: string; jobId: string } | null {
  const match = /(?:boards|job-boards)\.greenhouse\.io\/([^/]+)\/jobs\/([^/?#]+)/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { token: match[1], jobId: match[2] };
}

export function parseLeverUrl(url: string): { slug: string; jobId: string } | null {
  const match = /jobs\.(?:eu\.)?lever\.co\/([^/]+)\/([^/?#]+)/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { slug: match[1], jobId: match[2] };
}

export function parseAshbyUrl(url: string): { slug: string; jobId?: string } | null {
  const match = /jobs\.ashbyhq\.com\/([^/?#]+)(?:\/([^/?#]+))?/.exec(url);
  if (!match?.[1]) return null;
  return match[2] ? { slug: match[1], jobId: match[2] } : { slug: match[1] };
}

export function parseWorkdayUrl(url: string): { host: string; tenant: string; site: string; path: string } | null {
  const match = /https?:\/\/(([^.]+)\.wd\d+\.myworkdayjobs\.com)(\/.*)?/i.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return null;

  const segments = match[3].split('/').filter(Boolean);
  if (/^[a-z]{2}(?:-[A-Z]{2})?$/i.test(segments[0] ?? '')) segments.shift();
  const jobIndex = segments.indexOf('job');
  if (jobIndex < 1) return null;

  const site = segments[jobIndex - 1];
  if (!site) return null;
  const path = `/${segments.slice(jobIndex).join('/')}`;
  return { host: match[1], tenant: match[2], site, path };
}

export function parseSmartRecruitersUrl(url: string): { company: string; postingId: string } | null {
  const match = /jobs\.smartrecruiters\.com\/([^/]+)\/([^/?#]+)/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { company: match[1], postingId: match[2] };
}

export function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function htmlToPlaintext(rawHtml: string): string {
  if (!rawHtml) return '';

  let text = rawHtml;
  for (let i = 0; i < 5; i++) {
    const unescaped = unescapeHtml(text);
    if (unescaped === text) break;
    text = unescaped;
  }

  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > PLAINTEXT_CAP) {
    text = text.substring(0, PLAINTEXT_CAP);
  }

  return text;
}

async function fetchGreenhouseDescription(posting: PostingInfo): Promise<string | null> {
  const parsed = parseGreenhouseUrl(posting.url);
  if (!parsed) return null;

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${parsed.token}/jobs/${parsed.jobId}?content=true`;
  const response = await fetch(apiUrl);
  if (!response.ok) return null;

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) return null;

  const content = (data as Record<string, unknown>)['content'];
  if (typeof content !== 'string') return null;

  return htmlToPlaintext(content);
}

async function fetchLeverDescription(posting: PostingInfo): Promise<string | null> {
  const parsed = parseLeverUrl(posting.url);
  if (!parsed) return null;

  const apiHost = posting.url.includes('jobs.eu.lever.co') ? 'api.eu.lever.co' : 'api.lever.co';
  const apiUrl = `https://${apiHost}/v0/postings/${parsed.slug}/${parsed.jobId}`;
  const response = await fetch(apiUrl);
  if (!response.ok) return null;

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) return null;

  const description = (data as Record<string, unknown>)['descriptionPlain'];
  if (typeof description !== 'string') return null;

  const trimmed = description.trim();
  return trimmed.length > PLAINTEXT_CAP ? trimmed.substring(0, PLAINTEXT_CAP) : trimmed;
}

async function fetchWorkdayDescription(posting: PostingInfo): Promise<string | null> {
  const parsed = parseWorkdayUrl(posting.url);
  if (!parsed) return null;

  const apiUrl = `https://${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}${parsed.path}`;
  const response = await fetch(apiUrl);
  if (!response.ok) return null;

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) return null;

  const description = (data as Record<string, unknown>)['jobDescription'];
  if (typeof description !== 'string') return null;

  return htmlToPlaintext(description);
}

async function fetchSmartRecruitersDescription(posting: PostingInfo): Promise<string | null> {
  const parsed = parseSmartRecruitersUrl(posting.url);
  if (!parsed) return null;

  const apiUrl = `https://api.smartrecruiters.com/v1/companies/${parsed.company}/postings/${parsed.postingId}`;
  const response = await fetch(apiUrl);
  if (!response.ok) return null;

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) return null;

  const jobDesc = (data as Record<string, unknown>)['jobDescription'];

  const parts: string[] = [];
  const jobAd = (data as Record<string, unknown>)['jobAd'];
  if (typeof jobAd === 'object' && jobAd !== null) {
    const sections = (jobAd as Record<string, unknown>)['sections'];
    if (typeof sections === 'object' && sections !== null) {
      for (const section of Object.values(sections)) {
        if (typeof section === 'object' && section !== null) {
          const text = (section as Record<string, unknown>)['text'];
          if (typeof text === 'string') parts.push(text);
        }
      }
    }
  }

  if (parts.length === 0 && typeof jobDesc === 'object' && jobDesc !== null) {
    const sections = (jobDesc as Record<string, unknown>)['sections'];
    if (Array.isArray(sections)) {
      for (const section of sections) {
        if (typeof section === 'object' && section !== null) {
          const text = (section as Record<string, unknown>)['text'];
          if (typeof text === 'string') parts.push(text);
        }
      }
    }
  }

  if (parts.length === 0) return null;
  return htmlToPlaintext(parts.join(' '));
}

async function fetchAshbyDescription(
  posting: PostingInfo,
  boardCache: Map<string, Array<Record<string, unknown>>>,
): Promise<string | null> {
  const parsed = parseAshbyUrl(posting.url);
  if (!parsed) return null;

  let jobs = boardCache.get(parsed.slug);

  if (!jobs) {
    const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${parsed.slug}?includeCompensation=true`;
    const response = await fetch(apiUrl);
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null) return null;

    const rawJobs = (data as Record<string, unknown>)['jobs'];
    if (!Array.isArray(rawJobs)) return null;

    jobs = rawJobs as Array<Record<string, unknown>>;
    boardCache.set(parsed.slug, jobs);
  }

  const matchingJob = jobs.find(
    (job) => job['id'] === (parsed.jobId ?? posting.source_job_id),
  );
  if (!matchingJob) return null;

  const description = matchingJob['descriptionPlain'];
  if (typeof description !== 'string') return null;

  const trimmed = description.trim();
  return trimmed.length > PLAINTEXT_CAP ? trimmed.substring(0, PLAINTEXT_CAP) : trimmed;
}

function getHostForSource(ats: string, url?: string): string {
  switch (ats) {
    case 'greenhouse': return 'boards-api.greenhouse.io';
    case 'lever': return 'api.lever.co';
    case 'ashby': return 'api.ashbyhq.com';
    case 'smartrecruiters': return 'api.smartrecruiters.com';
    case 'workday': {
      if (url) {
        const parsed = parseWorkdayUrl(url);
        if (parsed) return parsed.host;
      }
      return 'myworkdayjobs.com';
    }
    default: return 'unknown';
  }
}

export class DescriptionFetcher {
  private activeFetches = 0;
  private hostTimestamps = new Map<string, number>();
  private ashbyBoardCache = new Map<string, Array<Record<string, unknown>>>();
  private corsFailures = new Set<string>();

  async fetchOne(posting: PostingInfo): Promise<DescriptionResult> {
    const ats = posting.ats || posting.source;
    if (!['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters'].includes(ats)) {
      return { id: posting.id, description: null, error: null };
    }

    await this.acquireSlot(getHostForSource(ats, posting.url));

    try {
      let description: string | null = null;

      switch (ats) {
        case 'greenhouse':
          description = await fetchGreenhouseDescription(posting);
          break;
        case 'lever':
          description = await fetchLeverDescription(posting);
          break;
        case 'ashby':
          description = await fetchAshbyDescription(posting, this.ashbyBoardCache);
          break;
        case 'workday':
          description = await fetchWorkdayDescription(posting);
          break;
        case 'smartrecruiters':
          description = await fetchSmartRecruitersDescription(posting);
          break;
      }

      return { id: posting.id, description, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const key = `${ats}:${posting.company_slug}`;
      if (!this.corsFailures.has(key)) {
        this.corsFailures.add(key);
        console.warn(`[nightjar] description fetch failed for ${key}: ${message}`);
      }
      return { id: posting.id, description: null, error: message };
    } finally {
      this.releaseSlot();
    }
  }

  getCorsFailures(): string[] {
    return [...this.corsFailures];
  }

  getAshbyBoardCache(): Map<string, Array<Record<string, unknown>>> {
    return this.ashbyBoardCache;
  }

  private async acquireSlot(host: string): Promise<void> {
    while (this.activeFetches >= MAX_CONCURRENT) {
      await sleep(50);
    }
    this.activeFetches++;

    const lastRequest = this.hostTimestamps.get(host) ?? 0;
    const elapsed = Date.now() - lastRequest;
    if (elapsed < MIN_HOST_DELAY_MS) {
      await sleep(MIN_HOST_DELAY_MS - elapsed);
    }
    this.hostTimestamps.set(host, Date.now());
  }

  private releaseSlot(): void {
    this.activeFetches--;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePostingData(row: { id: string; data: string }): PostingInfo | null {
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    const url = parsed['url'];
    const source = parsed['source'];
    const sourceJobId = parsed['source_job_id'];
    const companySlug = parsed['company_slug'];
    const ats = parsed['ats'];

    if (
      typeof url !== 'string' ||
      typeof source !== 'string' ||
      typeof sourceJobId !== 'string' ||
      typeof companySlug !== 'string'
    ) {
      return null;
    }

    return {
      id: row.id,
      url,
      source,
      source_job_id: sourceJobId,
      company_slug: companySlug,
      ats: typeof ats === 'string' ? ats : source,
    };
  } catch {
    return null;
  }
}

export async function prefetchDescriptions(
  db: Database,
  limit: number = DEFAULT_PREFETCH_LIMIT,
  profile?: Profile,
): Promise<DescriptionResult[]> {
  const retryBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.query<{ id: string; data: string }>(
    `SELECT id, data FROM postings_cache
     WHERE description IS NULL AND closed_at IS NULL
       AND (description_attempted_at IS NULL OR description_attempted_at <= ?)
     ORDER BY CASE WHEN description_attempted_at IS NULL THEN 0 ELSE 1 END,
              COALESCE(score, 0) DESC, first_seen_at DESC
     LIMIT ?`,
    [retryBefore, limit],
  );

  if (rows.length === 0) return [];

  const postings: PostingInfo[] = [];
  for (const row of rows) {
    const info = parsePostingData(row);
    if (info) postings.push(info);
  }

  if (postings.length === 0) return [];

  const fetcher = new DescriptionFetcher();
  const results: DescriptionResult[] = [];

  const pending: Array<Promise<void>> = [];
  for (const posting of postings) {
    const promise = fetcher.fetchOne(posting).then(async (result) => {
      results.push(result);
      const attemptedAt = new Date().toISOString();
      if (result.description !== null) {
        await db.run(
          `UPDATE postings_cache
           SET description = ?, description_attempted_at = ?, description_error = NULL
           WHERE id = ?`,
          [result.description, attemptedAt, result.id],
        );
        if (profile) {
          await recomputePosting(db, result.id, profile);
        }
      } else {
        await db.run(
          `UPDATE postings_cache
           SET description_attempted_at = ?, description_error = ?
           WHERE id = ?`,
          [attemptedAt, result.error ?? 'Description unavailable from source', result.id],
        );
      }
    });
    pending.push(promise);
  }

  await Promise.all(pending);

  return results;
}
