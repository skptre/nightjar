import { JobDetail } from '@/components/JobDetail';
import { matchesGraduationStage } from './opportunity-stage';
import { Glyph } from '@/components/Icon';
import { saveJob, markJobApplied } from './job-actions';
import { DOMAIN_OPTIONS, matchesRoleSelection, parseRoleDomains } from '@/classify/role-taxonomy';
import {
  useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { useSync } from '@/providers/SyncProvider';
import { useKeyboard } from '@/hooks/useKeyboard';
import { useDensity } from '@/hooks/useAppearance';
import { openExternal } from '@/lib/platform';
import { focusHeaderSearch } from '@/lib/search';
import { useToast } from '@/components/Toast';
import { Panel } from '@/motion/Panel';
import {
  afterRender, animateScroll, playFlip, snapshotRows, useGlide, useLayer, useScrollThumb, useTweenedNumber,
} from '@/motion/motion';
import { payFromColumns } from '@/details/pay-label';
import type { Profile } from '@/profile/types';
import { isTracked, PostingRow, type BookmarkPop, type PostingAction, type PostingRowData } from './PostingRow';
import {
  feedSnapshot, feedSubscribe, setFeed, setScrollTopSilent, nextLoadEpoch, currentLoadEpoch,
  profileSignature, type FeedState,
} from './feed-store';
import {
  CATEGORY_FILTER_GROUPS,
  CATEGORY_OPTIONS,
  parseCategoryTags,
  type CategoryOption,
} from '@/classify/types';

interface PostingQueryRow {
  id: string;
  data: string;
  first_seen_at: string;
  closed_at: string | null;
  category: string | null;
  category_tags: string | null;
  role_classification?: string | null;
  term: string | null;
  eligibility: string | null;
  score: number | null;
  score_breakdown: string | null;
  has_description: number | null;
  application_status: string | null;
  pay_status?: string | null;
  pay_ranges?: string | null;
}

// The list needs only whether a description exists (a boolean); the full text is
// fetched on demand by the row preview and the sheet. Pay comes from the details
// cache as two small JSON fragments rather than the whole cached document.
export const CURRENT_JOBS_QUERY = `SELECT p.id, p.data, p.first_seen_at, p.closed_at, p.category, p.category_tags, p.role_classification,
              p.term, p.eligibility, p.score, p.score_breakdown,
              (CASE WHEN p.description IS NOT NULL AND p.description != '' THEN 1 ELSE 0 END) AS has_description,
              a.status AS application_status,
              json_extract(d.details_json, '$.compensation.status') AS pay_status,
              json_extract(d.details_json, '$.compensation.ranges') AS pay_ranges
       FROM postings_cache p
       LEFT JOIN applications a ON p.id = a.posting_id
       LEFT JOIN job_details_cache d ON d.posting_id = p.id
       WHERE p.closed_at IS NULL
         AND p.id NOT LIKE 'local-%'
         AND (a.posting_id IS NULL OR a.status != 'skipped')
       ORDER BY p.first_seen_at DESC`;

function parsePostingRow(row: PostingQueryRow): PostingRowData | null {
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    return {
      id: row.id,
      company: (parsed['company'] as string) ?? '',
      company_slug: (parsed['company_slug'] as string) ?? '',
      title: (parsed['title'] as string) ?? '',
      location: (parsed['location'] as string) ?? '',
      locations: (parsed['locations'] as string[]) ?? [],
      url: (parsed['url'] as string) ?? '',
      source: (parsed['source'] as string) ?? '',
      first_seen_at: row.first_seen_at ?? (parsed['first_seen_at'] as string) ?? '',
      closed_at: row.closed_at,
      category: row.category,
      category_tags: parseCategoryTags(row.category_tags, row.category),
      domain_tags: parseRoleDomains(row.role_classification),
      term: row.term,
      eligibility: row.eligibility,
      score: row.score,
      score_breakdown: row.score_breakdown,
      compensation: (parsed['compensation'] as string) ?? null,
      pay_label: payFromColumns(row.pay_status ?? null, row.pay_ranges ?? null),
      description_available: row.has_description === 1,
      // description_text is intentionally absent: an absent value means "not yet
      // loaded", so the detail views fetch it on demand.
      description_status: typeof parsed['description_status'] === 'string' ? parsed['description_status'] : undefined,
      application_status: row.application_status,
    };
  } catch {
    return null;
  }
}

export function filterOptionsForProfile(_targetCategories: readonly string[]): readonly CategoryOption[] {
  return CATEGORY_OPTIONS;
}

export function getFeedEmptyState(
  rawPostingCount: number,
  syncStatus: string,
): { title: string; detail: string | null } {
  if (rawPostingCount === 0 && syncStatus === 'error') {
    return {
      title: "Jobs couldn't be updated.",
      detail: 'Check your connection. Nightjar will retry automatically.',
    };
  }
  return { title: 'No jobs match these filters.', detail: null };
}

type FilterState = Pick<FeedState, 'viewMode' | 'selectedCategories' | 'selectedDomains' | 'companyFilter'> & { search: string };

function filterPostings(rows: PostingRowData[], f: FilterState, profile: Profile | null): PostingRowData[] {
  const query = f.search.trim().toLowerCase();
  const result: PostingRowData[] = [];
  for (const posting of rows) {
    if (f.viewMode === 'for-you' && !matchesGraduationStage(posting, profile?.graduation)) continue;
    if (f.companyFilter && posting.company_slug !== f.companyFilter) continue;
    if (f.viewMode === 'for-you' && profile && posting.eligibility) {
      try {
        const eligibility = JSON.parse(posting.eligibility) as { verdict?: string };
        if (eligibility.verdict === 'ineligible') continue;
      } catch {
        // Invalid cached eligibility stays visible for manual review.
      }
    }
    if (!matchesRoleSelection(posting.category_tags, posting.domain_tags ?? [], f.selectedCategories, f.selectedDomains)) continue;
    if (query && !posting.title.toLowerCase().includes(query) && !posting.company.toLowerCase().includes(query)) continue;
    result.push(posting);
  }
  if (f.viewMode === 'for-you' && profile) {
    result.sort((left, right) => {
      const scoreDifference = (right.score ?? -1) - (left.score ?? -1);
      if (scoreDifference !== 0) return scoreDifference;
      return right.first_seen_at.localeCompare(left.first_seen_at);
    });
  }
  return result;
}

const LIST_PAD = 10;
const OVERSCAN = 8;
const rowSelector = (id: string): string => `.jrow[data-id="${id.replace(/["\\]/g, '\\$&')}"]`;

export function FeedView(): React.ReactNode {
  const density = useDensity();
  const { db } = useDatabase();
  const { toast } = useToast();
  const { profile } = useProfile();
  const { clearNewPostingCount, status: syncStatus, lastSyncedAt } = useSync();
  const feed = useSyncExternalStore(feedSubscribe, feedSnapshot);
  const {
    rawRows, pendingRows, loaded, viewMode, selectedCategories, selectedDomains,
    search, companyFilter, detailId, openId, selectedIndex,
  } = feed;

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState<'depth' | 'morph'>('depth');
  const [sheetAnim, setSheetAnim] = useState('fwdA');
  const [pop, setPop] = useState<BookmarkPop | null>(null);
  // Rows that animate in after a change: the ids showing before (null = first
  // load, stagger the top rows) and the keyframe name to use this time.
  const [entrance, setEntrance] = useState<{ prev: Set<string> | null; name: string } | null>({ prev: null, name: 'rowIn' });
  const pageRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetScrollRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const flipSnap = useRef<Map<string, number> | null>(null);
  const pendingCenter = useRef<string | null>(null);
  const cancelScroll = useRef<() => void>(() => {});
  const glide = useGlide();
  const listThumb = useScrollThumb();
  const sheetThumb = useScrollThumb();
  const sheetOpen = detailId !== null;
  const layerOpen = sheetOpen || filtersOpen;
  useLayer(layerOpen);

  const deferredSearch = useDeferredValue(search);
  const bumpReload = useCallback((): void => {
    setFeed({ reloadKey: feedSnapshot().reloadKey + 1 });
  }, []);

  useEffect(() => { clearNewPostingCount(); }, [clearNewPostingCount]);

  // On arrival, honour explicit ?company / ?q navigation intent.
  const appliedUrlParams = useRef(false);
  useEffect(() => {
    if (appliedUrlParams.current) return;
    appliedUrlParams.current = true;
    const params = new URLSearchParams(window.location.search);
    const company = params.get('company');
    const query = params.get('q');
    if (company !== null || query !== null) {
      setFeed({ ...(company !== null ? { companyFilter: company } : {}), ...(query !== null ? { search: query } : {}) });
    }
  }, []);

  // Reload only when the data could have changed: a sync finished, ranking
  // preferences changed, or a local mutation happened.
  const loadSignature = `${lastSyncedAt ?? ''}::${profileSignature(profile)}::${String(feed.reloadKey)}`;
  useEffect(() => {
    const snapshot = feedSnapshot();
    if (snapshot.loaded && snapshot.loadedSignature === loadSignature) return;
    let cancelled = false;
    const myEpoch = nextLoadEpoch();
    // Render imported rows immediately. SyncManager refreshes classification in
    // the background and publishes another signature when it finishes.
    void db.query<PostingQueryRow>(CURRENT_JOBS_QUERY)
      .then((rows) => {
        if (cancelled || myEpoch !== currentLoadEpoch()) return;
        const parsed = rows.map(parsePostingRow).filter((row): row is PostingRowData => row !== null);
        const previous = feedSnapshot().rawRows;
        const known = new Set(previous.map((row) => row.id));
        if (previous.length > 0 && parsed.some((row) => !known.has(row.id))) {
          // Refresh existing rows in place; hold genuinely new rows behind "Show"
          // so nothing is inserted under the cursor.
          const updated = new Map(parsed.map((row) => [row.id, row]));
          setFeed({
            pendingRows: parsed,
            rawRows: previous.flatMap((row) => (updated.has(row.id) ? [updated.get(row.id)!] : [])),
            loaded: true,
            loadedSignature: loadSignature,
          });
        } else {
          setFeed({ rawRows: parsed, pendingRows: null, loaded: true, loadedSignature: loadSignature });
        }
      })
      .catch(() => {
        if (cancelled || myEpoch !== currentLoadEpoch()) return;
        setFeed({ loaded: true, loadedSignature: loadSignature });
        toast('Could not load your jobs. Please reopen this page.', 'error');
      });
    return () => { cancelled = true; };
  }, [db, profile, loadSignature, toast]);

  const postings = useMemo(
    () => filterPostings(rawRows, { viewMode, selectedCategories, selectedDomains, companyFilter, search: deferredSearch }, profile),
    [rawRows, deferredSearch, selectedCategories, selectedDomains, viewMode, profile, companyFilter],
  );
  const postingIds = useMemo(() => postings.map((posting) => posting.id), [postings]);
  const emptyState = getFeedEmptyState(rawRows.length, syncStatus);
  const shownCount = useTweenedNumber(postings.length, 360);

  // Entrance animations apply right after a change, never to rows that scroll
  // into view later.
  useEffect(() => {
    if (!entrance) return;
    const timer = setTimeout(() => setEntrance(null), 1200);
    return () => clearTimeout(timer);
  }, [entrance]);
  const firstLoad = useRef(!loaded);
  useEffect(() => {
    if (loaded && firstLoad.current) { firstLoad.current = false; setEntrance({ prev: null, name: 'rowIn' }); }
  }, [loaded]);

  // ── Windowed list: fixed-height rows plus the one row that may be open ──────
  const [stride, setStride] = useState(density === 'compact' ? 54 : 66);
  useEffect(() => setStride(density === 'compact' ? 54 : 66), [density]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [extra, setExtra] = useState(0);
  const openIdx = openId ? postingIds.indexOf(openId) : -1;
  const offsetOf = useCallback((i: number): number => i * stride + (openIdx >= 0 && i > openIdx ? extra : 0), [stride, openIdx, extra]);
  const indexAt = (y: number): number => {
    if (openIdx >= 0 && y >= offsetOf(openIdx) + stride + extra) return Math.floor((y - extra) / stride);
    return Math.floor(y / stride);
  };
  const height = viewH || 900;
  const start = Math.max(0, Math.min(postings.length, indexAt(scrollTop - LIST_PAD) - OVERSCAN));
  const end = Math.min(postings.length, Math.max(start, indexAt(scrollTop - LIST_PAD + height) + OVERSCAN + 1));
  const total = postings.length * stride + (openIdx >= 0 ? extra : 0);

  const rafRef = useRef(0);
  const onListScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    listThumb.onScroll(e);
    const el = e.currentTarget;
    setScrollTopSilent(el.scrollTop);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setScrollTop(el.scrollTop));
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const hasList = loaded && postings.length > 0;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasList]);
  // Restore the scroll position once when the list remounts.
  const scrollRestored = useRef(false);
  useLayoutEffect(() => {
    if (scrollRestored.current || !hasList) return;
    const el = listRef.current;
    if (!el) return;
    if (feed.scrollTop > 0) { el.scrollTop = feed.scrollTop; setScrollTop(feed.scrollTop); }
    scrollRestored.current = true;
  }, [hasList, feed.scrollTop]);
  // Measure the real row height and how much the open row adds.
  useLayoutEffect(() => {
    const closed = innerRef.current?.querySelector<HTMLElement>('.jrow:not(.open)');
    if (closed && closed.offsetHeight > 0) {
      const next = closed.offsetHeight + 4;
      if (Math.abs(next - stride) > 0.5) setStride(next);
    }
  });
  useEffect(() => {
    const row = openId ? innerRef.current?.querySelector<HTMLElement>(rowSelector(openId)) : null;
    if (!row) { setExtra(0); return; }
    const measure = (): void => { if (row.offsetHeight) setExtra(Math.max(0, row.offsetHeight + 4 - stride)); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [openId, stride, start, end]);

  const resetListPosition = useCallback((): void => {
    setFeed({ selectedIndex: 0 });
    setScrollTopSilent(0);
    cancelScroll.current();
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, []);
  // A new search from the header starts the list at the top.
  const lastSearch = useRef(search);
  useEffect(() => {
    if (lastSearch.current === search) return;
    lastSearch.current = search;
    resetListPosition();
  }, [search, resetListPosition]);

  /** Apply a filter change: surviving rows slide to their new place, new rows rise in. */
  const refilter = useCallback((patch: Partial<FeedState>): void => {
    const rows = Array.from(innerRef.current?.querySelectorAll<HTMLElement>('.jrow') ?? []);
    flipSnap.current = snapshotRows(innerRef.current, '.jrow');
    glide.hide();
    setEntrance((e) => ({ prev: new Set(rows.map((r) => r.dataset.id!)), name: e?.name === 'rowIn' ? 'rowIn2' : 'rowIn' }));
    setFeed(patch);
    resetListPosition();
    afterRender(() => { if (flipSnap.current && playFlip(innerRef.current, '.jrow', flipSnap.current)) flipSnap.current = null; });
  }, [glide, resetListPosition]);

  const toggleIn = (key: 'selectedCategories' | 'selectedDomains', value: string): void => {
    const next = new Set(feedSnapshot()[key]);
    if (next.has(value)) next.delete(value); else next.add(value);
    refilter({ [key]: next });
  };
  const clearFilters = (): void => refilter({ selectedCategories: new Set(), selectedDomains: new Set(), search: '', companyFilter: null });

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleUndo = useCallback((postingId: string): void => {
    void db.run('DELETE FROM applications WHERE posting_id = ?', [postingId]).then(() => bumpReload());
  }, [db, bumpReload]);

  const handleAction = useCallback((id: string, action: PostingAction): void => {
    const posting = rawRows.find((candidate) => candidate.id === id);
    if (!posting) return;
    const now = new Date().toISOString();
    if (action === 'open') {
      void openExternal(posting.url).then((opened) => { if (!opened) toast('Could not open this job link.', 'error'); });
      return;
    }
    if (action === 'save' || action === 'apply') {
      void (action === 'save' ? saveJob(db, id) : markJobApplied(db, id)).then(() => {
        bumpReload();
        toast(action === 'save' ? 'Saved to your tracker' : 'Application recorded', 'success',
          action === 'apply' ? { dot: 'var(--st-applied)' } : {});
      }).catch(() => toast('Could not save this change. Please try again.', 'error'));
      return;
    }
    if (isTracked(posting.application_status)) {
      toast('Manage this saved application in Tracker.', 'info');
      return;
    }
    void db.run(
      `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
       VALUES (?, 'skipped', COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
      [id, id, now, now],
    ).then(() => {
      bumpReload();
      toast(`Skipped “${posting.title}”`, 'info', { actions: [{ label: 'Undo', onClick: () => handleUndo(id) }] });
    });
  }, [db, rawRows, toast, bumpReload, handleUndo]);

  /** The bookmark saves a role, or un-saves one that is only saved. */
  const toggleSave = useCallback((id: string): void => {
    const posting = rawRows.find((candidate) => candidate.id === id);
    if (!posting) return;
    if (isTracked(posting.application_status) && posting.application_status !== 'saved') {
      toast('Manage this application in Tracker.', 'info');
      return;
    }
    const on = posting.application_status !== 'saved';
    setPop((p) => ({ id, on, n: (p?.n ?? 0) + 1 }));
    // Show the new state right away; the reload confirms it.
    setFeed({ rawRows: feedSnapshot().rawRows.map((row) => row.id === id ? { ...row, application_status: on ? 'saved' : null } : row) });
    const write = on ? saveJob(db, id)
      : db.run("DELETE FROM applications WHERE posting_id = ? AND status = 'saved'", [id]);
    void write.then(() => {
      bumpReload();
      toast(on ? 'Saved to your tracker' : 'Removed from your tracker', 'success', on ? {} : {
        actions: [{ label: 'Undo', onClick: () => { void saveJob(db, id).then(bumpReload); } }],
      });
    }).catch(() => { bumpReload(); toast('Could not save this change. Please try again.', 'error'); });
  }, [db, rawRows, toast, bumpReload]);

  // ── Sheet ──────────────────────────────────────────────────────────────────
  /** Container transform: an empty card grows from the row into the sheet. */
  const morphFrom = (row: HTMLElement | null): boolean => {
    const page = pageRef.current, sheet = sheetRef.current, shell = shellRef.current;
    if (!page || !sheet || !shell || !row) return false;
    const P = page.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (!r.width || !P.width || !sheet.offsetWidth) return false;
    const a = { x: r.left - P.left, y: r.top - P.top, w: r.width, h: r.height };
    const b = { x: (page.clientWidth - sheet.offsetWidth) / 2, y: 22, w: sheet.offsetWidth, h: sheet.offsetHeight };
    const put = (q: typeof a, radius: string): void => {
      shell.style.left = `${String(q.x)}px`; shell.style.top = `${String(q.y)}px`;
      shell.style.width = `${String(q.w)}px`; shell.style.height = `${String(q.h)}px`; shell.style.borderRadius = radius;
    };
    shell.style.transition = 'none';
    put(a, '16px');
    shell.style.opacity = '1';
    void shell.getBoundingClientRect();
    shell.style.transition = `${['left', 'top', 'width', 'height', 'border-radius'].map((p) => `${p} 680ms var(--out)`).join(', ')}, opacity 220ms ease 500ms`;
    put(b, '28px');
    shell.style.opacity = '0';
    // The sheet starts just under its resting place and fades in over the shell.
    sheet.style.transition = 'none';
    sheet.style.transform = 'translate3d(0,14px,0)';
    void sheet.getBoundingClientRect();
    requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transition = ''; sheet.style.transform = ''; }));
    return true;
  };
  const openSheet = useCallback((id: string, row: HTMLElement | null): void => {
    const morphed = morphFrom(row);
    glide.hide();
    setSheetMode(morphed ? 'morph' : 'depth');
    setSheetAnim((a) => (a === 'fwdA' ? 'fwdB' : 'fwdA'));
    setFeed({ detailId: id, openId: id });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glide]);
  const closeSheet = useCallback((): void => {
    const id = feedSnapshot().detailId;
    setSheetMode('depth');
    setFeed({ detailId: null });
    if (id) requestAnimationFrame(() => innerRef.current?.querySelector<HTMLElement>(`${rowSelector(id)} .jrow-main`)?.focus({ preventScroll: true }));
  }, []);

  /** Keeps the open row near the middle of the list's clear area. */
  const runCenter = useCallback((): void => {
    const id = pendingCenter.current, L = listRef.current;
    if (!id || !L) return;
    const idx = postingIds.indexOf(id);
    const row = L.querySelector<HTMLElement>(rowSelector(id));
    if (idx < 0 || !row || !row.classList.contains('open')) return;
    pendingCenter.current = null;
    const body = row.querySelector<HTMLElement>('[data-body]');
    const h = stride - 4 + (body?.offsetHeight ?? 160);
    const top = LIST_PAD + idx * stride;
    cancelScroll.current();
    cancelScroll.current = animateScroll(L, top - (L.clientHeight * 0.4 - h / 2), 640);
  }, [postingIds, stride]);

  const step = useCallback((dir: number): void => {
    const idx = postingIds.indexOf(feedSnapshot().detailId ?? '');
    const n = idx + dir;
    if (idx < 0 || n < 0 || n >= postingIds.length) return;
    setSheetAnim((a) => dir > 0 ? (a === 'fwdA' ? 'fwdB' : 'fwdA') : (a === 'backA' ? 'backB' : 'backA'));
    pendingCenter.current = postingIds[n]!;
    setFeed({ detailId: postingIds[n]!, openId: postingIds[n]!, selectedIndex: n });
    afterRender(runCenter);
  }, [postingIds, runCenter]);
  useEffect(() => { sheetScrollRef.current?.scrollTo?.(0, 0); }, [detailId]);

  /** Scrolls just enough to keep a row comfortably inside the list. */
  const ensureVisible = (index: number): void => {
    const L = listRef.current;
    if (!L) return;
    const top = LIST_PAD + index * stride;
    const bottom = top + stride + 180;
    cancelScroll.current();
    if (top < L.scrollTop + 30) cancelScroll.current = animateScroll(L, top - 30, 420);
    else if (bottom > L.scrollTop + L.clientHeight * 0.8) cancelScroll.current = animateScroll(L, bottom - L.clientHeight * 0.8, 420);
  };

  const toggleRow = useCallback((id: string): void => {
    glide.hide();
    const open = feedSnapshot().openId === id;
    setFeed({ openId: open ? null : id, selectedIndex: Math.max(0, postingIds.indexOf(id)) });
  }, [glide, postingIds]);

  const handleEscape = useCallback((): void => {
    if (feedSnapshot().detailId) { closeSheet(); return; }
    if (filtersOpen) { setFiltersOpen(false); return; }
    if (feedSnapshot().openId) setFeed({ openId: null });
  }, [filtersOpen, closeSheet]);

  useKeyboard({
    postingIds,
    selectedIndex: openIdx >= 0 ? openIdx : selectedIndex,
    onSelectIndex: (index) => {
      const sheetId = feedSnapshot().detailId;
      if (sheetId) { step(index - postingIds.indexOf(sheetId)); return; }
      setFeed({ selectedIndex: index, openId: postingIds[index] ?? null });
      ensureVisible(index);
    },
    onAction: (id, action) => {
      if (action === 'save') toggleSave(id);
      else handleAction(id, action === 'apply' ? 'open' : action);
    },
    onSearchFocus: focusHeaderSearch,
    onEscape: handleEscape,
    disabled: filtersOpen,
  });
  // Arrows step through postings while the sheet is open; Enter opens the open row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const s = feedSnapshot();
      if (s.detailId && e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (s.detailId && e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (!s.detailId && !filtersOpen && e.key === 'Enter' && s.openId && (!el || el === document.body)) {
        e.preventDefault();
        openSheet(s.openId, innerRef.current?.querySelector<HTMLElement>(rowSelector(s.openId)) ?? null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, openSheet, filtersOpen]);
  useEffect(() => {
    if (filtersOpen) requestAnimationFrame(() => filtersRef.current?.querySelector<HTMLElement>('.seg button, button.chip')?.focus({ preventScroll: true }));
  }, [filtersOpen]);

  // ── Labels ─────────────────────────────────────────────────────────────────
  const summary = [
    ...CATEGORY_OPTIONS.filter((o) => selectedCategories.has(o.value)).map((o) => o.shortLabel),
    ...DOMAIN_OPTIONS.filter((o) => selectedDomains.has(o.value)).map((o) => o.label),
  ];
  const companyName = companyFilter ? rawRows.find((r) => r.company_slug === companyFilter)?.company ?? companyFilter : null;
  const nFilters = selectedCategories.size + selectedDomains.size + (companyFilter ? 1 : 0);
  const hasAnything = nFilters > 0 || Boolean(search);
  const countLabel = `${shownCount.toLocaleString('en-US')} ${shownCount === 1 ? 'role' : 'roles'}`
    + (companyName ? ` at ${companyName}` : '') + (summary.length ? ` · ${summary.join(', ')}` : '');
  const sheetPosting = detailId ? postings.find((p) => p.id === detailId) ?? rawRows.find((p) => p.id === detailId) ?? null : null;
  // Keep the last posting rendered while the sheet falls back into depth.
  const lastSheetPosting = useRef<PostingRowData | null>(null);
  if (sheetPosting) lastSheetPosting.current = sheetPosting;
  const shownSheet = sheetPosting ?? lastSheetPosting.current;
  const sheetIdx = sheetPosting ? postingIds.indexOf(sheetPosting.id) : -1;
  const newPostingTotal = pendingRows ? pendingRows.length - rawRows.length : 0;

  // "A little too narrow": find the one filter whose removal brings roles back.
  const narrow = useMemo(() => {
    if (postings.length || !rawRows.length) return null;
    const base: FilterState = { viewMode, selectedCategories, selectedDomains, companyFilter, search };
    const options: { label: string; patch: Partial<FeedState>; count: number }[] = [];
    const tryPatch = (label: string, patch: Partial<FeedState> & Partial<FilterState>): void => {
      options.push({ label, patch, count: filterPostings(rawRows, { ...base, ...patch } as FilterState, profile).length });
    };
    for (const value of selectedCategories) {
      const next = new Set(selectedCategories); next.delete(value);
      tryPatch(CATEGORY_OPTIONS.find((o) => o.value === value)?.shortLabel ?? value, { selectedCategories: next });
    }
    for (const value of selectedDomains) {
      const next = new Set(selectedDomains); next.delete(value);
      tryPatch(DOMAIN_OPTIONS.find((o) => o.value === value)?.label ?? value, { selectedDomains: next });
    }
    if (companyFilter) tryPatch(companyName ?? 'the company', { companyFilter: null });
    if (search) tryPatch(`“${search}”`, { search: '' });
    const best = options.filter((o) => o.count > 0).sort((a, b) => b.count - a.count)[0] ?? null;
    return { chips: options.map((o) => o.label), best };
  }, [postings.length, rawRows, selectedCategories, selectedDomains, companyFilter, search, viewMode, profile, companyName]);

  const loading = !loaded || (syncStatus === 'syncing' && rawRows.length === 0);
  let fresh = 0;

  return (
    <div ref={pageRef} className="page page-enter">
      <Panel className={`jobs-panel depth ${layerOpen ? 'behind' : ''}`} aria-label="Jobs" {...(layerOpen ? { inert: true } : {})}>
        <div className="list-head">
          <div className="title">
            <h1 className="h1">Internships</h1>
            <span className="count" aria-live="polite">{loading ? '' : countLabel}</span>
          </div>
          <div className="tools">
            {hasAnything && <button type="button" className="txt" onClick={clearFilters}>Clear</button>}
            <button type="button" className="icb pillbtn" onClick={() => { glide.hide(); setFiltersOpen(true); }} aria-haspopup="dialog" aria-label="Filters"
              style={{ paddingRight: nFilters ? 8 : 18, gap: 10 }}>
              <span>Filters</span>{nFilters > 0 && <span className="badge" key={nFilters}>{nFilters}</span>}
            </button>
          </div>
        </div>
        <div className="colhead-wrap">
          <div className="colhead cols jobs-cols">
            <span>Role</span><span className="c-loc">Location</span><span className="c-pay">Pay</span><span style={{ textAlign: 'right' }}>Posted</span>
          </div>
          <span />
        </div>
        <div className="list-area">
          {pendingRows && newPostingTotal > 0 && <button type="button" className="new-pill" onClick={() => {
            const prev = new Set(postingIds);
            setFeed({ rawRows: feedSnapshot().pendingRows ?? [], pendingRows: null });
            resetListPosition();
            setEntrance({ prev, name: 'rowIn2' });
          }}>
            {newPostingTotal} new {newPostingTotal === 1 ? 'role' : 'roles'} available <span>Show <Glyph name="go" size={12} /></span>
          </button>}
          {loading ? <div className="list-scroll scroll fade-list" role="status" aria-label="Loading jobs">
            {Array.from({ length: 10 }, (_, i) => <div className="skel-row" key={i} style={i ? undefined : { borderTop: 0 }}>
              <span className="mark" /><span className="sk" style={{ width: `${String(30 + ((i * 37) % 30))}%` }} /><span className="sk" style={{ width: '12%', marginLeft: 'auto', opacity: 0.6 }} />
            </div>)}
          </div> : postings.length === 0 ? (
            narrow && hasAnything ? <div className="empty">
              <div className="chips">{narrow.chips.map((label) => <span key={label} className="chip" aria-pressed="true" style={{ display: 'inline-flex', alignItems: 'center' }}>{label}</span>)}</div>
              <h2>A little too narrow.</h2>
              <p>{narrow.best ? `No roles match all of these. Dropping ${narrow.best.label} brings back ${narrow.best.count.toLocaleString('en-US')}.` : 'No roles match these filters right now.'}</p>
              <div className="acts">
                {narrow.best && <button type="button" className="solid" onClick={() => refilter(narrow.best!.patch)}>Drop {narrow.best.label}</button>}
                <button type="button" className="ghost" onClick={clearFilters}>Show all jobs</button>
              </div>
            </div> : <div className="empty">
              <h2>{emptyState.title}</h2>
              <p>{emptyState.detail ?? 'Try another view, or check back after the next update.'}</p>
            </div>
          ) : (
            <div ref={listRef} role="list" aria-label="Job postings" className="list-scroll scroll fade-list"
              onScroll={onListScroll} onMouseMove={glide.onMouseMove} onMouseLeave={glide.onMouseLeave}>
              <div ref={innerRef} className="list-inner">
                <div ref={glide.glideRef} className="glide" aria-hidden="true" />
                <div style={{ height: offsetOf(start) }} aria-hidden="true" />
                {postings.slice(start, end).map((posting, offset) => {
                  const index = start + offset;
                  let anim: string | null = null;
                  if (entrance) {
                    if (!entrance.prev) { if (index < 13) anim = `rowIn 560ms var(--out) ${String(index * 32)}ms backwards`; }
                    else if (!entrance.prev.has(posting.id)) anim = `${entrance.name} 560ms var(--out) ${String(60 + fresh++ * 40)}ms backwards`;
                  }
                  return <PostingRow key={posting.id} posting={posting} open={posting.id === openId} anim={anim} pop={pop}
                    dataToken={lastSyncedAt} onToggle={toggleRow} onSave={toggleSave} onApply={(id) => handleAction(id, 'open')} onReadFull={openSheet} />;
                })}
                <div style={{ height: Math.max(0, total - offsetOf(end)) }} aria-hidden="true" />
              </div>
            </div>
          )}
          <div className="thumb-track" aria-hidden="true"><div ref={listThumb.thumbRef} className="thumb" /></div>
        </div>
      </Panel>

      {layerOpen && <button type="button" className="scrim" aria-label="Close" tabIndex={-1} onClick={() => { if (filtersOpen) setFiltersOpen(false); else closeSheet(); }} />}

      <div className={`ghost-card g2 ${sheetOpen ? 'on' : ''}`} aria-hidden="true" />
      <div className={`ghost-card g1 ${sheetOpen ? 'on' : ''}`} aria-hidden="true" />
      <div ref={shellRef} className="shell" aria-hidden="true" />

      <div ref={sheetRef} role="dialog" aria-modal="true" aria-label="Posting" className={`sheet posting-sheet ${sheetOpen ? 'on' : ''} ${sheetMode === 'morph' ? 'morph' : ''}`}
        {...(!sheetOpen ? { inert: true } : {})}>
        <div className="sheet-bar">
          <div>
            <button type="button" className="icb round" onClick={() => step(-1)} disabled={sheetIdx <= 0} aria-label="Previous posting"><Glyph name="prev" size={14} /></button>
            <button type="button" className="icb round" onClick={() => step(1)} disabled={sheetIdx < 0 || sheetIdx >= postingIds.length - 1} aria-label="Next posting"><Glyph name="next" size={14} /></button>
            {sheetIdx >= 0 && <span className="dim tnum" style={{ fontSize: 14, marginLeft: 6 }}>{(sheetIdx + 1).toLocaleString('en-US')} of {postingIds.length.toLocaleString('en-US')}</span>}
          </div>
          <button type="button" className="icb round" onClick={closeSheet} aria-label="Close posting"><Glyph name="close" size={13} /></button>
        </div>
        <div className="sheet-scroll-wrap">
          <div ref={sheetScrollRef} className="sheet-scroll scroll fade-sheet" onScroll={sheetThumb.onScroll}>
            {shownSheet && <div key={shownSheet.id} className="sheet-body" style={{ animation: `${sheetAnim} 520ms var(--out) both` }}>
              <JobDetail posting={shownSheet} dataToken={lastSyncedAt} onAction={handleAction} pop={pop} onSave={() => toggleSave(shownSheet.id)} />
            </div>}
          </div>
          <div className="thumb-track" aria-hidden="true"><div ref={sheetThumb.thumbRef} className="thumb" /></div>
        </div>
      </div>

      <div ref={filtersRef} role="dialog" aria-modal="true" aria-label="Filters" className={`sheet filters-sheet ${filtersOpen ? 'on' : ''}`} {...(!filtersOpen ? { inert: true } : {})}>
        <div className="filters-head">
          <h2 className="sheet-title">Filters</h2>
          <button type="button" className="icb round" onClick={() => setFiltersOpen(false)} aria-label="Close filters"><Glyph name="close" size={13} /></button>
        </div>
        <div className="filters-body scroll">
          {profile && <section>
            <h3>Show</h3>
            <div className="seg lg" style={{ alignSelf: 'flex-start' }} aria-label="Job view">
              <button type="button" aria-pressed={viewMode === 'for-you'} onClick={() => refilter({ viewMode: 'for-you', selectedCategories: new Set(profile.target_categories), selectedDomains: new Set() })}>For you</button>
              <button type="button" aria-pressed={viewMode === 'all'} onClick={() => refilter({ viewMode: 'all', selectedCategories: new Set(), selectedDomains: new Set() })}>All jobs</button>
            </div>
          </section>}
          <section style={{ gap: 18 }}>
            <h3>Roles</h3>
            {CATEGORY_FILTER_GROUPS.map((group) => <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="chip-group-label">{group.label}</span>
              <div className="chips">{group.options.map((option) => <button key={option.value} type="button" className="chip"
                aria-pressed={selectedCategories.has(option.value)} onClick={() => toggleIn('selectedCategories', option.value)}>{option.shortLabel}</button>)}</div>
            </div>)}
          </section>
          <section style={{ gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h3>Fields</h3>
              <span className="dim" style={{ fontSize: 14 }}>Combine with a role to narrow it, like SWE in Aerospace.</span>
            </div>
            <div className="chips">{DOMAIN_OPTIONS.map((option) => <button key={option.value} type="button" className="chip"
              aria-pressed={selectedDomains.has(option.value)} onClick={() => toggleIn('selectedDomains', option.value)}>{option.label}</button>)}</div>
          </section>
        </div>
        <div className="filters-foot">
          <button type="button" className="txt" style={{ fontSize: 15, color: 'rgba(var(--fg-rgb),.6)' }} disabled={selectedCategories.size + selectedDomains.size === 0}
            onClick={() => refilter({ selectedCategories: new Set(), selectedDomains: new Set() })}>Reset</button>
          <button type="button" className="solid lg" onClick={() => setFiltersOpen(false)}>Show {postings.length.toLocaleString('en-US')} {postings.length === 1 ? 'role' : 'roles'}</button>
        </div>
      </div>
    </div>
  );
}
