import type { NightjarDB } from '@/db/database';
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
}

export interface DescriptionResult {
  id: string;
  description: string | null;
  error: string | null;
}

export function parseGreenhouseUrl(url: string): { token: string; jobId: string } | null {
  const match = /boards\.greenhouse\.io\/([^/]+)\/jobs\/([^/?#]+)/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { token: match[1], jobId: match[2] };
}

export function parseLeverUrl(url: string): { slug: string; jobId: string } | null {
  const match = /jobs\.lever\.co\/([^/]+)\/([^/?#]+)/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { slug: match[1], jobId: match[2] };
}

export function parseAshbyUrl(url: string): { slug: string } | null {
  const match = /jobs\.ashbyhq\.com\/([^/]+)/.exec(url);
  if (!match?.[1]) return null;
  return { slug: match[1] };
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

  const apiUrl = `https://api.lever.co/v0/postings/${parsed.slug}/${parsed.jobId}`;
  const response = await fetch(apiUrl);
  if (!response.ok) return null;

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) return null;

  const description = (data as Record<string, unknown>)['descriptionPlain'];
  if (typeof description !== 'string') return null;

  const trimmed = description.trim();
  return trimmed.length > PLAINTEXT_CAP ? trimmed.substring(0, PLAINTEXT_CAP) : trimmed;
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
    (job) => job['id'] === posting.source_job_id,
  );
  if (!matchingJob) return null;

  const description = matchingJob['descriptionPlain'];
  if (typeof description !== 'string') return null;

  const trimmed = description.trim();
  return trimmed.length > PLAINTEXT_CAP ? trimmed.substring(0, PLAINTEXT_CAP) : trimmed;
}

function getHostForSource(source: string): string {
  switch (source) {
    case 'greenhouse': return 'boards-api.greenhouse.io';
    case 'lever': return 'api.lever.co';
    case 'ashby': return 'api.ashbyhq.com';
    default: return 'unknown';
  }
}

export class DescriptionFetcher {
  private activeFetches = 0;
  private hostTimestamps = new Map<string, number>();
  private ashbyBoardCache = new Map<string, Array<Record<string, unknown>>>();
  private corsFailures = new Set<string>();

  async fetchOne(posting: PostingInfo): Promise<DescriptionResult> {
    await this.acquireSlot(getHostForSource(posting.source));

    try {
      let description: string | null = null;

      switch (posting.source) {
        case 'greenhouse':
          description = await fetchGreenhouseDescription(posting);
          break;
        case 'lever':
          description = await fetchLeverDescription(posting);
          break;
        case 'ashby':
          description = await fetchAshbyDescription(posting, this.ashbyBoardCache);
          break;
      }

      return { id: posting.id, description, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const key = `${posting.source}:${posting.company_slug}`;
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

    if (
      typeof url !== 'string' ||
      typeof source !== 'string' ||
      typeof sourceJobId !== 'string' ||
      typeof companySlug !== 'string'
    ) {
      return null;
    }

    return { id: row.id, url, source, source_job_id: sourceJobId, company_slug: companySlug };
  } catch {
    return null;
  }
}

export async function prefetchDescriptions(
  db: NightjarDB,
  limit: number = DEFAULT_PREFETCH_LIMIT,
  profile?: Profile,
): Promise<DescriptionResult[]> {
  const rows = db.query<{ id: string; data: string }>(
    `SELECT id, data FROM postings_cache
     WHERE description IS NULL AND closed_at IS NULL
     ORDER BY COALESCE(score, 0) DESC, first_seen_at DESC
     LIMIT ?`,
    [limit],
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
    const promise = fetcher.fetchOne(posting).then((result) => {
      results.push(result);
      if (result.description !== null) {
        db.run(
          'UPDATE postings_cache SET description = ? WHERE id = ?',
          [result.description, result.id],
        );
        if (profile) {
          recomputePosting(db, result.id, profile);
        }
      }
    });
    pending.push(promise);
  }

  await Promise.all(pending);

  return results;
}
