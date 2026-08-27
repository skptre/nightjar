import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { recomputeAll } from '@/classify/recompute';
import { ExcludeToggle } from './ExcludeToggle';

type Tab = 'postings' | 'applications' | 'timeline';

interface PostingQueryRow {
  id: string;
  data: string;
  category: string | null;
  eligibility: string | null;
  score: number | null;
  closed_at: string | null;
  first_seen_at: string | null;
}

interface ApplicationQueryRow {
  posting_id: string;
  status: string;
  applied_at: string | null;
  deadline: string | null;
  notes: string | null;
  next_action: string | null;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ParsedPosting {
  id: string;
  title: string;
  location: string;
  url: string;
  source: string;
  first_seen_at: string | null;
  closed_at: string | null;
  category: string | null;
  eligibility: string | null;
  score: number | null;
}

interface TimelineEntry {
  date: string;
  type: string;
  label: string;
}

function extractField(data: string, field: string): string {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return (parsed[field] as string) ?? '';
  } catch {
    return '';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function eligibilityColor(verdict: string | null): string {
  if (!verdict) return 'text-gray-400 dark:text-nj-muted';
  if (verdict.includes('eligible') && !verdict.includes('ineligible')) return 'text-nj-eligible';
  if (verdict.includes('ineligible')) return 'text-nj-ineligible';
  return 'text-nj-unclear';
}

function scoreColor(score: number | null): string {
  if (score === null) return 'text-gray-400 dark:text-nj-muted';
  if (score >= 70) return 'text-nj-score-high';
  if (score >= 40) return 'text-nj-score-mid';
  return 'text-nj-score-low';
}

function verdictLabel(raw: string | null): string {
  if (!raw) return 'unclear';
  try {
    const parsed = JSON.parse(raw) as { verdict?: string };
    return parsed.verdict ?? 'unclear';
  } catch {
    return raw;
  }
}

export function CompanyDetail(): ReactNode {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { db } = useDatabase();
  const { profile, updateProfile } = useProfile();

  const [tab, setTab] = useState<Tab>('postings');
  const [postings, setPostings] = useState<ParsedPosting[]>([]);
  const [applications, setApplications] = useState<(ApplicationQueryRow & { title: string })[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [atsType, setAtsType] = useState('');
  const [editingContact, setEditingContact] = useState(false);
  const [contactValue, setContactValue] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    void db.query<PostingQueryRow>(
      'SELECT id, data, category, eligibility, score, closed_at, first_seen_at FROM postings_cache',
    ).then((rows) => {
      if (cancelled) return;
      const matching: ParsedPosting[] = [];
      let name = '';
      let source = '';

      for (const row of rows) {
        const rowSlug = extractField(row.data, 'company_slug');
        if (rowSlug !== slug) continue;

        if (!name) {
          name = extractField(row.data, 'company');
          source = extractField(row.data, 'source');
        }

        matching.push({
          id: row.id,
          title: extractField(row.data, 'title'),
          location: extractField(row.data, 'location'),
          url: extractField(row.data, 'url'),
          source: extractField(row.data, 'source'),
          first_seen_at: row.first_seen_at,
          closed_at: row.closed_at,
          category: row.category,
          eligibility: row.eligibility,
          score: row.score,
        });
      }

      matching.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      setPostings(matching);
      setCompanyName(name);
      setAtsType(source);
    });

    return () => { cancelled = true; };
  }, [db, slug, refreshKey]);

  useEffect(() => {
    if (!slug || postings.length === 0) return;
    let cancelled = false;
    const ids = postings.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');

    void db.query<ApplicationQueryRow>(
      `SELECT posting_id, status, applied_at, deadline, notes,
              next_action, next_action_at, created_at, updated_at
       FROM applications
       WHERE posting_id IN (${placeholders})
       ORDER BY updated_at DESC`,
      ids,
    ).then((rows) => {
      if (cancelled) return;
      const result = rows.map((r) => {
        const posting = postings.find((p) => p.id === r.posting_id);
        return { ...r, title: posting?.title ?? '' };
      });
      setApplications(result);
    });

    return () => { cancelled = true; };
  }, [db, slug, postings]);

  const tier = profile?.tiers[slug ?? ''];
  const contact = profile?.contacts[slug ?? ''];
  const isExcluded = profile?.excluded_companies.includes(slug ?? '');

  const activeCount = postings.filter((p) => !p.closed_at).length;
  const closedCount = postings.filter((p) => p.closed_at).length;
  const appCount = applications.length;
  const latestDate = postings.reduce<string>((latest, p) => {
    if (p.first_seen_at && (!latest || p.first_seen_at > latest)) return p.first_seen_at;
    return latest;
  }, '');

  const timeline = useMemo((): TimelineEntry[] => {
    const entries: TimelineEntry[] = [];
    for (const p of postings) {
      if (p.first_seen_at) {
        entries.push({ date: p.first_seen_at, type: 'posting', label: `New posting: ${p.title}` });
      }
      if (p.closed_at) {
        entries.push({ date: p.closed_at, type: 'closed', label: `Closed: ${p.title}` });
      }
    }
    for (const a of applications) {
      if (a.applied_at) {
        entries.push({ date: a.applied_at, type: 'applied', label: `Applied: ${a.title}` });
      }
      entries.push({ date: a.updated_at, type: 'status', label: `${a.title} → ${a.status}` });
    }
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return entries;
  }, [postings, applications]);

  const handleTierChange = useCallback(
    (value: string): void => {
      if (!profile || !slug) return;
      const newTiers = { ...profile.tiers };
      if (value === '' || value === 'untiered') {
        delete newTiers[slug];
      } else {
        newTiers[slug] = parseInt(value, 10) as 1 | 2 | 3;
      }
      updateProfile({ tiers: newTiers });
      void recomputeAll(db, { ...profile, tiers: newTiers });
      setRefreshKey((k) => k + 1);
    },
    [db, profile, slug, updateProfile],
  );

  const handleExclude = useCallback((): void => {
    if (!profile || !slug) return;
    const excluded = new Set(profile.excluded_companies);
    if (excluded.has(slug)) {
      excluded.delete(slug);
    } else {
      excluded.add(slug);
    }
    updateProfile({ excluded_companies: Array.from(excluded) });
  }, [profile, slug, updateProfile]);

  const handleSaveContact = useCallback((): void => {
    if (!profile || !slug) return;
    const newContacts = { ...profile.contacts };
    if (contactValue.trim()) {
      newContacts[slug] = contactValue.trim();
    } else {
      delete newContacts[slug];
    }
    updateProfile({ contacts: newContacts });
    setEditingContact(false);
  }, [profile, slug, updateProfile, contactValue]);

  const handleStatusChange = useCallback(
    async (postingId: string, newStatus: string): Promise<void> => {
      const now = new Date().toISOString();
      await db.run(
        'UPDATE applications SET status = ?, updated_at = ? WHERE posting_id = ?',
        [newStatus, now, postingId],
      );
      setRefreshKey((k) => k + 1);
    },
    [db],
  );

  if (!slug) return null;

  return (
    <div>
      <button
        onClick={() => void navigate('/companies')}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-nj-text-dim dark:hover:text-nj-text mb-3"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Companies
      </button>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-nj-text">
            {companyName || slug}
          </h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-nj-surface-2 text-gray-600 dark:text-nj-text-dim uppercase font-medium">
              {atsType || 'unknown'}
            </span>
            <select
              value={tier !== undefined ? String(tier) : ''}
              onChange={(e) => handleTierChange(e.target.value)}
              className={`px-2 py-1 text-xs rounded border cursor-pointer ${
                tier === 1 ? 'border-amber-400 bg-amber-50 text-amber-800 dark:border-nj-tier-1/30 dark:bg-nj-tier-1/10 dark:text-nj-tier-1'
                  : tier === 2 ? 'border-blue-300 bg-blue-50 text-blue-800 dark:border-nj-tier-2/30 dark:bg-nj-tier-2/10 dark:text-nj-tier-2'
                    : tier === 3 ? 'border-gray-300 bg-gray-50 text-gray-700 dark:border-nj-tier-3/30 dark:bg-nj-tier-3/10 dark:text-nj-tier-3'
                      : 'border-gray-200 bg-white text-gray-500 dark:border-nj-border dark:bg-nj-surface dark:text-nj-muted'
              }`}
            >
              <option value="">Untiered</option>
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
            </select>
            <ExcludeToggle excluded={!!isExcluded} onToggle={handleExclude} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-4">
        <StatCard label="Active Postings" value={String(activeCount)} />
        <StatCard label="Closed" value={String(closedCount)} />
        <StatCard label="Applications" value={String(appCount)} />
        <StatCard label="Latest Posting" value={formatDate(latestDate || null)} />
      </div>

      <div className="mb-4 p-3 border border-gray-200 dark:border-nj-border rounded-lg bg-white dark:bg-nj-surface">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-gray-600 dark:text-nj-text-dim uppercase tracking-wider">Contact Notes</span>
          {!editingContact && (
            <button
              onClick={() => { setEditingContact(true); setContactValue(contact ?? ''); }}
              className="text-xs text-nj-accent dark:text-nj-accent-bright hover:underline"
            >
              {contact ? 'Edit' : '+ Add'}
            </button>
          )}
        </div>
        {editingContact ? (
          <div className="space-y-2">
            <textarea
              value={contactValue}
              onChange={(e) => setContactValue(e.target.value)}
              rows={3}
              className="w-full text-sm p-2 border border-gray-200 dark:border-nj-border-bright rounded bg-white dark:bg-nj-surface-2 text-gray-900 dark:text-nj-text resize-none focus:outline-none focus:ring-1 focus:ring-nj-accent"
              placeholder="e.g., Warm intro via Sarah, applied Oct 2026"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={handleSaveContact} className="text-xs px-2 py-1 bg-nj-accent text-white rounded hover:bg-nj-accent-dim">Save</button>
              <button onClick={() => setEditingContact(false)} className="text-xs px-2 py-1 text-gray-500 dark:text-nj-text-dim">Cancel</button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-600 dark:text-nj-text-dim whitespace-pre-wrap">
            {contact || 'No contact notes yet.'}
          </p>
        )}
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-nj-border mb-4">
        {(['postings', 'applications', 'timeline'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-nj-accent text-nj-accent dark:text-nj-accent-bright'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-nj-text-dim dark:hover:text-nj-text'
            }`}
          >
            {t === 'postings' ? `Postings (${String(postings.length)})`
              : t === 'applications' ? `Applications (${String(applications.length)})`
                : 'Timeline'}
          </button>
        ))}
      </div>

      {tab === 'postings' && <PostingsTab postings={postings} />}
      {tab === 'applications' && <ApplicationsTab applications={applications} onStatusChange={handleStatusChange} />}
      {tab === 'timeline' && <TimelineTab entries={timeline} />}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="p-3 border border-gray-200 dark:border-nj-border rounded-lg bg-white dark:bg-nj-surface text-center">
      <p className="text-lg font-semibold text-gray-900 dark:text-nj-text">{value}</p>
      <p className="text-xs text-gray-500 dark:text-nj-muted">{label}</p>
    </div>
  );
}

function PostingsTab({ postings }: { postings: ParsedPosting[] }): ReactNode {
  if (postings.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-nj-muted py-8 text-center">No postings found for this company.</p>;
  }
  return (
    <div className="border border-gray-200 dark:border-nj-border rounded-lg overflow-hidden">
      <div className="grid grid-cols-[1fr_120px_80px_80px_70px] gap-2 px-4 py-2 bg-gray-50 dark:bg-nj-surface border-b border-gray-200 dark:border-nj-border text-xs font-semibold text-gray-500 dark:text-nj-muted uppercase tracking-wider">
        <span>Title</span>
        <span className="text-center">Location</span>
        <span className="text-center">Posted</span>
        <span className="text-center">Eligibility</span>
        <span className="text-center">Score</span>
      </div>
      {postings.map((p) => (
        <a
          key={p.id}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`grid grid-cols-[1fr_120px_80px_80px_70px] gap-2 px-4 py-2.5 items-center border-b border-gray-100 dark:border-nj-border last:border-b-0 hover:bg-gray-50 dark:hover:bg-nj-surface-2/50 transition-colors ${
            p.closed_at ? 'opacity-50' : ''
          }`}
        >
          <div className="min-w-0">
            <span className="text-sm text-gray-900 dark:text-nj-text truncate block">{p.title}</span>
            {p.category && <span className="text-xs text-gray-400 dark:text-nj-muted">{p.category}</span>}
          </div>
          <span className="text-xs text-gray-500 dark:text-nj-text-dim text-center truncate">{p.location || '—'}</span>
          <span className="text-xs text-gray-500 dark:text-nj-text-dim text-center">{formatDate(p.first_seen_at)}</span>
          <span className={`text-xs text-center font-medium ${eligibilityColor(p.eligibility)}`}>
            {verdictLabel(p.eligibility)}
          </span>
          <span className={`text-sm text-center font-medium tabular-nums ${scoreColor(p.score)}`}>
            {p.score !== null ? String(Math.round(p.score)) : '—'}
          </span>
        </a>
      ))}
    </div>
  );
}

function ApplicationsTab({
  applications,
  onStatusChange,
}: {
  applications: (ApplicationQueryRow & { title: string })[];
  onStatusChange: (postingId: string, status: string) => Promise<void>;
}): ReactNode {
  if (applications.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-nj-muted py-8 text-center">No applications for this company yet.</p>;
  }

  const statuses = ['saved', 'applied', 'oa', 'phone', 'onsite', 'offer', 'rejected', 'ghosted', 'skipped'];

  return (
    <div className="border border-gray-200 dark:border-nj-border rounded-lg overflow-hidden">
      <div className="grid grid-cols-[1fr_100px_90px_90px_120px] gap-2 px-4 py-2 bg-gray-50 dark:bg-nj-surface border-b border-gray-200 dark:border-nj-border text-xs font-semibold text-gray-500 dark:text-nj-muted uppercase tracking-wider">
        <span>Title</span>
        <span className="text-center">Status</span>
        <span className="text-center">Applied</span>
        <span className="text-center">Deadline</span>
        <span>Notes</span>
      </div>
      {applications.map((a) => (
        <div
          key={a.posting_id}
          className="grid grid-cols-[1fr_100px_90px_90px_120px] gap-2 px-4 py-2.5 items-center border-b border-gray-100 dark:border-nj-border last:border-b-0"
        >
          <span className="text-sm text-gray-900 dark:text-nj-text truncate">{a.title}</span>
          <div className="flex justify-center">
            <select
              value={a.status}
              onChange={(e) => void onStatusChange(a.posting_id, e.target.value)}
              className="text-xs px-1.5 py-1 rounded border border-gray-200 dark:border-nj-border bg-white dark:bg-nj-surface-2 text-gray-700 dark:text-nj-text cursor-pointer"
            >
              {statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <span className="text-xs text-gray-500 dark:text-nj-text-dim text-center">{formatDate(a.applied_at)}</span>
          <span className="text-xs text-gray-500 dark:text-nj-text-dim text-center">{a.deadline ? formatDate(a.deadline) : '—'}</span>
          <span className="text-xs text-gray-500 dark:text-nj-text-dim truncate">{a.notes || '—'}</span>
        </div>
      ))}
    </div>
  );
}

function TimelineTab({ entries }: { entries: TimelineEntry[] }): ReactNode {
  if (entries.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-nj-muted py-8 text-center">No activity recorded yet.</p>;
  }
  return (
    <div className="space-y-0">
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-3 py-2">
          <div className="flex flex-col items-center">
            <span className={`w-2 h-2 rounded-full mt-1.5 ${
              entry.type === 'posting' ? 'bg-nj-tier-2'
                : entry.type === 'closed' ? 'bg-nj-ineligible'
                  : entry.type === 'applied' ? 'bg-nj-eligible'
                    : 'bg-nj-unclear'
            }`} />
            {i < entries.length - 1 && <div className="w-px flex-1 bg-gray-200 dark:bg-nj-border mt-1" />}
          </div>
          <div className="pb-2">
            <p className="text-sm text-gray-900 dark:text-nj-text">{entry.label}</p>
            <p className="text-xs text-gray-400 dark:text-nj-muted">{formatDate(entry.date)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
