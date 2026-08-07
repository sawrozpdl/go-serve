import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Phone, Mail } from 'lucide-react';
import {
  ACQUISITION_SOURCES,
  LEAD_STAGES,
  LEAD_STAGE_META,
  type LeadStage,
} from '@cafe-mgmt/api-types';

import {
  useAdminLeads,
  useAdminCreateLead,
  useAdminPeople,
  useMe,
  type Lead,
  type LeadFilters,
  type LeadInput,
  type AcquisitionSource,
} from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { SearchInput } from '@/components/SearchInput';
import { LeadModal } from './lead/LeadModal';
import { fmtDay, fmtRelative, toneForDueDate } from '@/lib/dates';

const DUE_FILTERS: { value: NonNullable<LeadFilters['due']>; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'This week' },
];

const SOURCE_LABEL = Object.fromEntries(ACQUISITION_SOURCES.map((s) => [s.value, s.label])) as Record<
  AcquisitionSource,
  string
>;

/* Every café we're talking to but haven't signed yet — inbound from the public
 * form and whatever the field agents bring in, on one board. The filters live
 * in the URL so a row in the digest or the overview can deep-link straight to
 * "the four leads I'm late on". */
export function SuperLeadsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const people = useAdminPeople();
  const [creating, setCreating] = useState(false);
  const create = useAdminCreateLead();

  const stage = params.get('stage') as LeadStage | null;
  const source = params.get('source') as AcquisitionSource | null;
  const owner = params.get('owner') ?? '';
  const due = params.get('due') as LeadFilters['due'] | null;
  const search = params.get('q') ?? '';
  const includeClosed = params.get('closed') === '1';

  // A one-key patch of the query string, so each control stays a one-liner and
  // clearing a filter is `set(key, '')` rather than a URLSearchParams dance.
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const filters: LeadFilters = {
    stage: stage ? [stage] : undefined,
    source: source ?? undefined,
    owner_person_id: owner || undefined,
    due: due ?? undefined,
    q: search || undefined,
    // A named stage overrides the closed toggle server-side, so don't fight it.
    include_closed: includeClosed || undefined,
  };
  const q = useAdminLeads(filters);
  const leads = q.data?.leads ?? [];
  const counts = q.data?.counts;

  // "Mine" needs the acting admin's registry row, which only exists if someone
  // added them to People. Without one the chip would silently match nothing, so
  // it isn't offered.
  const myPersonId = useMemo(() => {
    const uid = me.data?.user_id;
    return uid ? people.data?.people.find((p) => p.user_id === uid)?.id : undefined;
  }, [me.data, people.data]);

  const filtered = !!(stage || source || owner || due || search);

  return (
    <PageShell
      eyebrow="Pipeline"
      title="Leads"
      subtitle="Cafés we're talking to, and who is chasing them"
      docTitle="Leads"
      actions={
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> New lead
        </button>
      }
    >
      <div className="filter-row lead-filters">
        <div className="chips">
          <button
            type="button"
            className={`chip ${!stage ? 'on' : ''}`}
            onClick={() => set('stage', '')}
          >
            All open
          </button>
          {LEAD_STAGES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${stage === s ? 'on' : ''}`}
              onClick={() => set('stage', stage === s ? '' : s)}
            >
              {LEAD_STAGE_META[s].label}
              {counts ? <span className="lead-chip-count">{counts[s] ?? 0}</span> : null}
            </button>
          ))}
        </div>

        <div className="chips">
          {DUE_FILTERS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`chip ${due === d.value ? 'on' : ''}`}
              onClick={() => set('due', due === d.value ? '' : d.value)}
            >
              {d.label}
            </button>
          ))}
          {myPersonId && (
            <button
              type="button"
              className={`chip ${owner === myPersonId ? 'on' : ''}`}
              onClick={() => set('owner', owner === myPersonId ? '' : myPersonId)}
            >
              Mine
            </button>
          )}
          <button
            type="button"
            className={`chip ${owner === 'none' ? 'on' : ''}`}
            onClick={() => set('owner', owner === 'none' ? '' : 'none')}
          >
            Unassigned
          </button>
        </div>

        <select value={source ?? ''} onChange={(e) => set('source', e.target.value)}>
          <option value="">Any source</option>
          {ACQUISITION_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <SearchInput
          value={search}
          onChange={(v) => set('q', v)}
          placeholder="Search café, contact, email or phone"
        />

        <label className="super-check">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => set('closed', e.target.checked ? '1' : '')}
          />
          Include won &amp; lost
        </label>
      </div>

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={leads.length === 0}
        errorTitle="Could not load the pipeline"
        emptyTitle={filtered ? 'Nothing matches those filters' : 'No leads yet'}
        emptyHint={
          filtered
            ? 'Clear a filter, or tick “Include won & lost” to see closed deals.'
            : 'Add the cafés you’re in conversation with. Requests from the public form land here too.'
        }
      >
        <div className="table-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Café</th>
                <th>Contact</th>
                <th>Source</th>
                <th>Stage</th>
                <th>Owner</th>
                <th>Next follow-up</th>
                <th>Last touch</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <LeadRow key={l.id} lead={l} onOpen={() => navigate(`/super/leads/${l.id}`)} />
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      {creating && (
        <LeadModal
          title="New lead"
          subtitle="A café name and a phone number is enough to start."
          initial={EMPTY_LEAD}
          busy={create.isPending}
          people={people.data?.people ?? []}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            const { id } = await create.mutateAsync(input);
            setCreating(false);
            navigate(`/super/leads/${id}`);
          }}
        />
      )}
    </PageShell>
  );
}

export const EMPTY_LEAD: LeadInput = {
  cafe_name: '',
  contact_name: '',
  email: '',
  phone: '',
  source: 'outbound',
  desired_plan: '',
  message: '',
  notes: '',
  next_follow_up_at: '',
};

function LeadRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const meta = LEAD_STAGE_META[lead.stage];
  const tone = toneForDueDate(lead.next_follow_up_at);
  const closed = lead.stage === 'won' || lead.stage === 'lost';

  return (
    <tr className={closed ? 'row-muted' : tone === 'critical' ? 'row-warn' : undefined}>
      <td>
        <button type="button" className="linklike" onClick={onOpen}>
          <strong>{lead.cafe_name}</strong>
        </button>
      </td>
      <td>
        <div className="person-contact">
          {lead.contact_name && <span>{lead.contact_name}</span>}
          {lead.email && <span><Mail size={11} strokeWidth={1.8} /> {lead.email}</span>}
          {lead.phone && <span><Phone size={11} strokeWidth={1.8} /> {lead.phone}</span>}
          {!lead.contact_name && !lead.email && !lead.phone && <span className="muted">—</span>}
        </div>
      </td>
      <td>{SOURCE_LABEL[lead.source] ?? lead.source}</td>
      <td><span className={`pill ${meta.cls}`}>{meta.label}</span></td>
      <td>{lead.owner_name || <span className="muted">unassigned</span>}</td>
      <td>
        {lead.next_follow_up_at ? (
          <span className={`lead-due lead-due--${tone}`}>{fmtDay(lead.next_follow_up_at)}</span>
        ) : (
          <span className="muted">{closed ? '—' : 'not booked'}</span>
        )}
      </td>
      <td className="muted">
        {lead.last_activity_at ? fmtRelative(lead.last_activity_at) : 'never'}
      </td>
    </tr>
  );
}
