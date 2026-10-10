import { useEffect, useMemo, useState } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { getJobDetails, acquisitionStatus } from './cache';
import { extractJobDetails } from './extract';
import { formatDescription, buildHighlights, type DescBlock, type Highlights } from './format';
import type { JobDetails } from './types';
import type { PostingRowData } from '@/views/Feed/PostingRow';

// Details are read once per posting and data version, then shared by the inline
// row preview and the full sheet.
const memo = new Map<string, JobDetails>();

export interface LoadedDetails {
  details: JobDetails | null;
  blocks: DescBlock[];
  highlights: Highlights;
  failed: boolean;
}

export function useJobDetails(posting: PostingRowData | null, dataToken?: string | number | null, onError?: () => void): LoadedDetails {
  const { db } = useDatabase();
  const key = posting ? `${posting.id}::${String(dataToken ?? '')}` : '';
  const immediate = useMemo(() => posting && posting.description_text !== undefined
    ? extractJobDetails(posting.description_text, {
      acquisition: acquisitionStatus(posting.description_status),
      ...(posting.compensation ? { advertisedCompensation: posting.compensation } : {}),
    }) : null, [posting?.description_text, posting?.description_status, posting?.compensation]);
  const [state, setState] = useState<{ key: string; details: JobDetails } | null>(() => (key && memo.has(key) ? { key, details: memo.get(key)! } : null));
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!posting || immediate) return;
    if (memo.has(key)) { setState({ key, details: memo.get(key)! }); return; }
    let cancelled = false;
    const timeout = setTimeout(() => { if (!cancelled) setFailed(key); }, 10000);
    void (async () => {
      const cached = await getJobDetails(db, posting.id);
      let details = cached?.details;
      if (!details) {
        const row = await db.queryOne<{ description: string | null; data: string }>(
          'SELECT description, data FROM postings_cache WHERE id = ?', [posting.id]);
        let status: unknown;
        try { status = (JSON.parse(row?.data ?? '{}') as { description_status?: unknown }).description_status; } catch { /* unknown */ }
        details = extractJobDetails(row?.description ?? null, { acquisition: acquisitionStatus(status),
          ...(posting.compensation ? { advertisedCompensation: posting.compensation } : {}) });
      }
      memo.set(key, details);
      if (memo.size > 400) memo.delete(memo.keys().next().value!);
      if (!cancelled) { clearTimeout(timeout); setState({ key, details }); }
    })().catch(() => { if (!cancelled) { setFailed(key); onError?.(); } });
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [db, key, posting?.id, posting?.compensation, immediate]);
  const details = immediate ?? (state?.key === key ? state.details : null);
  const blocks = useMemo(() => details?.document ? formatDescription(details.document) : [], [details]);
  const highlights = useMemo(() => buildHighlights(blocks), [blocks]);
  return { details, blocks, highlights, failed: failed === key && !details };
}

/** Up to three plain lines for the inline preview, taken from the posting's highlights. */
export function previewLines(highlights: Highlights, blocks: DescBlock[], max = 3): string[] {
  const source = highlights.blocks.length ? highlights.blocks : blocks;
  const lines: string[] = [];
  for (const block of source) {
    if (block.kind === 'heading') continue;
    const items = block.kind === 'list' ? block.items ?? [] : [block.text ?? ''];
    for (const item of items) {
      const text = item.trim();
      if (text) lines.push(text.length > 170 ? `${text.slice(0, 167).trimEnd()}…` : text);
      if (lines.length >= max) return lines;
    }
  }
  return lines;
}
