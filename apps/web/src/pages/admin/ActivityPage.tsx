import { useEffect, useMemo, useRef, useState } from 'react';
import { Filter, X as XIcon, ChevronDown } from 'lucide-react';

import {
  useAuditEvents,
  useAuditActors,
  type AuditEvent,
  type AuditFilters,
} from '@/lib/api';
import { DatePicker } from '@/components/DatePicker';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { RefreshButton } from '@/components/RefreshButton';
import { SearchInput } from '@/components/SearchInput';
import { TimePicker } from '@/components/TimePicker';

// =========================================================================
// Filter primitives — what the API understands.
// =========================================================================

const ENTITIES: { value: string; label: string }[] = [
  { value: 'expense', label: 'Expenses' },
  { value: 'expense_category', label: 'Expense categories' },
  { value: 'transfer', label: 'Transfers' },
  { value: 'cash_drop', label: 'Cash drops' },
  { value: 'shift', label: 'Shifts' },
  { value: 'order', label: 'Orders' },
  { value: 'order_item', label: 'Order items' },
  { value: 'order_adjustment', label: 'Discounts' },
  { value: 'payment', label: 'Payments' },
  { value: 'inventory_item', label: 'Inventory' },
  { value: 'pack_rule', label: 'Pack rules' },
  { value: 'menu_category', label: 'Menu categories' },
  { value: 'menu_item', label: 'Menu items' },
  { value: 'menu_item_link', label: 'Menu↔inventory' },
  { value: 'table', label: 'Tables' },
  { value: 'member', label: 'Members' },
  { value: 'invite', label: 'Invites' },
  { value: 'tenant', label: 'Workspace' },
  { value: 'house_tab', label: 'House tabs' },
];

const ACTIONS: { value: string; label: string }[] = [
  { value: 'create', label: 'Created' },
  { value: 'update', label: 'Updated' },
  { value: 'delete', label: 'Deleted' },
  { value: 'open', label: 'Opened' },
  { value: 'close', label: 'Closed' },
  { value: 'void', label: 'Voided' },
  { value: 'settle', label: 'Settled' },
];

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom';

// startOfDay / endOfDay return the local-time boundaries of a day as Date
// objects. We pin every preset to these so an activity created at, say,
// 11:59 pm tonight still falls inside today's window.
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function presetRange(p: Preset): { from?: string; to?: string } {
  const now = new Date();
  const startToday = startOfDay(now);
  const endToday = endOfDay(now);
  switch (p) {
    case 'today':
      return { from: startToday.toISOString(), to: endToday.toISOString() };
    case 'yesterday': {
      const y = new Date(startToday);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y).toISOString(), to: endOfDay(y).toISOString() };
    }
    case '7d': {
      const from = new Date(startToday);
      from.setDate(from.getDate() - 6);
      return { from: startOfDay(from).toISOString(), to: endToday.toISOString() };
    }
    case '30d': {
      const from = new Date(startToday);
      from.setDate(from.getDate() - 29);
      return { from: startOfDay(from).toISOString(), to: endToday.toISOString() };
    }
    default:
      return {};
  }
}

// =========================================================================
// Color-by-action (dot on the timeline rail).
// =========================================================================

function actionColor(action: string): string {
  switch (action) {
    case 'create':
    case 'open':
    case 'settle':
      return 'var(--ok-500, #15803d)';
    case 'update':
      return 'var(--amber-500, #c2891f)';
    case 'delete':
    case 'void':
    case 'close':
      return 'var(--bad-500, #b91c1c)';
    default:
      return 'var(--ink-400, #64748b)';
  }
}

// =========================================================================
// ActivityPage
// =========================================================================

export function ActivityPage() {
  const [preset, setPreset] = useState<Preset>('7d');
  const [customRange, setCustomRange] = useState<{ from?: string; to?: string }>({});
  const [actors, setActors] = useState<string[]>([]);
  const [entities, setEntities] = useState<string[]>([]);
  const [actionList, setActionList] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState(''); // debounced applied value

  // Debounce the search box so we don't refetch on every keystroke.
  useDebounce(() => setSearch(q), 300, [q]);

  const dateRange = preset === 'custom' ? customRange : presetRange(preset);
  const filters: AuditFilters = useMemo(
    () => ({
      actor: actors.length ? actors : undefined,
      entity: entities.length ? entities : undefined,
      action: actionList.length ? actionList : undefined,
      from: dateRange.from,
      to: dateRange.to,
      q: search || undefined,
    }),
    [actors, entities, actionList, dateRange.from, dateRange.to, search],
  );

  const list = useAuditEvents(filters);
  const allEvents: AuditEvent[] = list.data?.pages.flatMap((p) => p.items) ?? [];

  const actorsQ = useAuditActors();

  const groups = groupByDay(allEvents);
  const anyActiveFilter =
    actors.length > 0 || entities.length > 0 || actionList.length > 0 || !!search || preset !== 'all';

  return (
    <PageShell
      className="activity-shell"
      eyebrow="Who did what"
      title="Activity"
      actions={
        <>
          {anyActiveFilter && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setActors([]);
                setEntities([]);
                setActionList([]);
                setQ('');
                setSearch('');
                setPreset('7d');
                setCustomRange({});
              }}
            >
              <XIcon size={14} strokeWidth={1.5} /> Clear filters
            </button>
          )}
          <RefreshButton
            onClick={() => list.refetch()}
            busy={list.isFetching}
            label="Refresh activity"
          />
        </>
      }
      tabs={
        <>
          {/* Filter bar */}
          <div className="activity-filterbar">
            <div className="activity-chips">
              {(['today', 'yesterday', '7d', '30d', 'all'] as Preset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`chip${preset === p ? ' active' : ''}`}
                  onClick={() => setPreset(p)}
                >
                  {labelForPreset(p)}
                </button>
              ))}
              <button
                type="button"
                className={`chip${preset === 'custom' ? ' active' : ''}`}
                onClick={() => setPreset('custom')}
              >
                Custom
              </button>
            </div>

            <div className="activity-dropdowns">
              <MultiSelect
                label="Person"
                empty="anyone"
                options={
                  actorsQ.data?.map((a) => ({
                    value: a.actor_id ?? a.actor_email,
                    label: a.actor_name || a.actor_email,
                    sublabel: a.actor_email,
                  })) ?? []
                }
                selected={actors}
                onChange={setActors}
              />
              <MultiSelect
                label="Area"
                empty="all areas"
                options={ENTITIES.map((e) => ({ value: e.value, label: e.label }))}
                selected={entities}
                onChange={setEntities}
              />
              <MultiSelect
                label="Action"
                empty="any action"
                options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
                selected={actionList}
                onChange={setActionList}
              />
            </div>

            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search summary…"
              ariaLabel="Search activity"
            />
          </div>

          {preset === 'custom' && (
            <div className="activity-custom-range">
              <label>
                <span>From</span>
                <div className="activity-range-fields">
                  <DatePicker
                    value={datePartOfIso(customRange.from)}
                    onChange={(d) =>
                      setCustomRange((r) => ({ ...r, from: combineDateTimeToIso(d, timePartOfIso(r.from)) }))
                    }
                    max={todayLocalDate()}
                    placeholder="date"
                  />
                  <TimePicker
                    value={timePartOfIso(customRange.from)}
                    onChange={(t) =>
                      setCustomRange((r) => ({
                        ...r,
                        from: combineDateTimeToIso(datePartOfIso(r.from) || todayLocalDate(), t),
                      }))
                    }
                  />
                </div>
              </label>
              <label>
                <span>To</span>
                <div className="activity-range-fields">
                  <DatePicker
                    value={datePartOfIso(customRange.to)}
                    onChange={(d) =>
                      setCustomRange((r) => ({ ...r, to: combineDateTimeToIso(d, timePartOfIso(r.to)) }))
                    }
                    max={todayLocalDate()}
                    placeholder="date"
                  />
                  <TimePicker
                    value={timePartOfIso(customRange.to)}
                    onChange={(t) =>
                      setCustomRange((r) => ({
                        ...r,
                        to: combineDateTimeToIso(datePartOfIso(r.to) || todayLocalDate(), t),
                      }))
                    }
                  />
                </div>
              </label>
            </div>
          )}
        </>
      }
    >
        {/* Timeline */}
        {list.isPending && <LoadingState label="Loading activity…" />}
        {list.isError &&
          (list.error?.code === 'forbidden' ? (
            <div className="empty-state">this page is owner/manager only.</div>
          ) : (
            <ErrorState title="Could not load activity" onRetry={() => list.refetch()} />
          ))}
        {list.data && allEvents.length === 0 && (
          <div className="empty-state">
            no activity matches these filters.
            <br />
            try widening the date range.
          </div>
        )}

        {groups.length > 0 && (
          <div className="activity-feed">
            {groups.map((g) => (
              <section key={g.dayKey} className="activity-day">
                <div className="activity-day-head">{g.label}</div>
                <ul className="activity-list">
                  {g.items.map((e) => (
                    <li key={e.id} className="activity-row">
                      <span
                        className="activity-dot"
                        style={{ background: actionColor(e.action) }}
                        aria-hidden="true"
                      />
                      <span
                        className="activity-avatar"
                        title={e.actor_email}
                        style={{ background: hashColor(e.actor_email) }}
                      >
                        {initialsOf(e.actor_name || e.actor_email)}
                      </span>
                      <div className="activity-body">
                        <div className="activity-line1">
                          <strong>{e.actor_name || e.actor_email.split('@')[0]}</strong>{' '}
                          <span className="activity-summary">{e.summary}</span>
                        </div>
                        <div className="activity-line2">
                          {e.role_snap.length > 0 &&
                            e.role_snap.map((ro) => (
                              <span key={ro} className="role-chip">
                                {ro}
                              </span>
                            ))}
                          <span className="activity-entity">{e.entity}</span>
                        </div>
                      </div>
                      <time
                        className="activity-time num"
                        dateTime={e.created_at}
                        title={new Date(e.created_at).toLocaleString()}
                      >
                        {formatTimeOfDay(e.created_at)}
                      </time>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {list.hasNextPage && (
          <div className="activity-loadmore">
            <button
              type="button"
              className="btn"
              onClick={() => list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? 'loading…' : 'Load more'}
            </button>
          </div>
        )}
    </PageShell>
  );
}

// =========================================================================
// Helpers
// =========================================================================

function useDebounce(fn: () => void, ms: number, deps: unknown[]) {
  const ref = useRef(fn);
  ref.current = fn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => ref.current(), ms);
    return () => clearTimeout(t);
  }, deps);
}

function labelForPreset(p: Preset): string {
  switch (p) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case '7d':
      return '7 days';
    case '30d':
      return '30 days';
    case 'all':
      return 'All';
    case 'custom':
      return 'Custom';
  }
}

type Group = { dayKey: string; label: string; items: AuditEvent[] };

function groupByDay(events: AuditEvent[]): Group[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYest = new Date(startOfToday);
  startOfYest.setDate(startOfYest.getDate() - 1);

  const byKey = new Map<string, Group>();
  for (const e of events) {
    const d = new Date(e.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let label: string;
    if (d >= startOfToday) {
      label = `Today, ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    } else if (d >= startOfYest) {
      label = `Yesterday, ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    } else {
      label = d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      });
    }
    let group = byKey.get(key);
    if (!group) {
      group = { dayKey: key, label, items: [] };
      byKey.set(key, group);
    }
    group.items.push(e);
  }
  return [...byKey.values()].sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
}

function initialsOf(s: string): string {
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0]! + parts[1][0]!).toUpperCase();
  }
  if (parts.length === 1 && parts[0]) return parts[0].slice(0, 2).toUpperCase();
  return '??';
}

// Stable color per actor — same email always lands on the same hue.
function hashColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 55% 28%)`;
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// The custom range is stored as ISO timestamps but edited as separate date +
// time controls. These split an ISO into its local "YYYY-MM-DD" / "HH:MM"
// parts and recombine them, defaulting a missing time to start-of-day.
function localDtFromIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datePartOfIso(iso?: string): string {
  return localDtFromIso(iso).slice(0, 10);
}

function timePartOfIso(iso?: string): string {
  return localDtFromIso(iso).slice(11, 16);
}

function combineDateTimeToIso(date: string, time: string): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T${time || '00:00'}`);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function todayLocalDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// =========================================================================
// MultiSelect — small dropdown with checkboxes. Closes on outside click.
// =========================================================================

function MultiSelect({
  label,
  empty,
  options,
  selected,
  onChange,
}: {
  label: string;
  empty: string;
  options: { value: string; label: string; sublabel?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (!ref.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const summary = selected.length
    ? `${label}: ${selected.length}`
    : `${label} · ${empty}`;

  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  }

  return (
    <div className="activity-ms" ref={ref}>
      <button
        type="button"
        className={`btn${selected.length ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Filter size={13} strokeWidth={1.5} />
        <span>{summary}</span>
        <ChevronDown size={13} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="activity-ms-menu" role="listbox">
          {options.length === 0 && <div className="activity-ms-empty">No options</div>}
          {options.map((o) => (
            <label key={o.value} className="activity-ms-row">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              <span>
                {o.label}
                {o.sublabel && <em>{o.sublabel}</em>}
              </span>
            </label>
          ))}
          {selected.length > 0 && (
            <div className="activity-ms-foot">
              <button type="button" className="btn icon" onClick={() => onChange([])}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
