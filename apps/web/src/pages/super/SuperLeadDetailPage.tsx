import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, Mail, Pencil, Phone, Plus } from 'lucide-react';
import {
  ACQUISITION_SOURCES,
  LEAD_ACTIVITY_LABEL,
  LEAD_STAGE_META,
  LOGGABLE_LEAD_ACTIVITIES,
  OPEN_LEAD_STAGES,
  type LeadActivityKind,
  type LeadStage,
} from '@cafe-mgmt/api-types';

import {
  useAdminLead,
  useAdminUpdateLead,
  useAdminLogLeadActivity,
  useAdminConvertLead,
  useAdminLinkLead,
  useAdminPeople,
  useAdminPlans,
  useAdminTenants,
  type Lead,
  type LeadInput,
} from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { Modal } from '@/components/Modal';
import { DatePicker } from '@/components/DatePicker';
import { SearchSelect } from '@/components/SearchSelect';
import { LeadModal } from './lead/LeadModal';
import { fmtDay, fmtDayLong, fmtRelative, toneForDueDate } from '@/lib/dates';

/* One lead: who they are, what's been done about them, and the two ways to
 * close it. Winning is deliberately not a stage you can just pick — it happens
 * by acquiring a café, so a won lead always points at one. */
export function SuperLeadDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const q = useAdminLead(id);
  const people = useAdminPeople();
  const [editing, setEditing] = useState(false);
  const update = useAdminUpdateLead(id);

  const lead = q.data?.lead;
  const closed = lead ? lead.stage === 'won' || lead.stage === 'lost' : false;

  return (
    <PageShell
      eyebrow="Pipeline"
      title={lead?.cafe_name ?? 'Lead'}
      subtitle={lead ? subtitleFor(lead) : undefined}
      docTitle={lead?.cafe_name ?? 'Lead'}
      actions={
        <>
          <button className="btn" onClick={() => navigate('/super/leads')}>
            <ArrowLeft size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> All leads
          </button>
          {lead && !closed && (
            <button className="btn" onClick={() => setEditing(true)}>
              <Pencil size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> Edit
            </button>
          )}
        </>
      }
    >
      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        errorTitle="Could not load this lead"
      >
        {lead && (
          <div className="lead-detail">
            <div className="lead-detail-main">
              <StagePanel lead={lead} />
              {/* No composer once the lead is WON: the café has its own notes
                  timeline now, and offering both is how account history ends up
                  split across two places. A LOST lead keeps it — "rang back in
                  November, still no" belongs here and nowhere else. */}
              <ActivityPanel
                id={id}
                activities={q.data?.activities ?? []}
                readOnly={lead.stage === 'won'}
                tenantId={lead.converted_tenant_id}
              />
            </div>
            <div className="lead-detail-side">
              <FactsPanel lead={lead} />
              {!closed && <ClosePanel lead={lead} />}
            </div>
          </div>
        )}
      </QueryState>

      {editing && lead && (
        <LeadModal
          title="Edit lead"
          initial={toInput(lead)}
          busy={update.isPending}
          people={people.data?.people ?? []}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            await update.mutateAsync({ ...input, stage: lead.stage });
            setEditing(false);
          }}
        />
      )}
    </PageShell>
  );
}

function subtitleFor(lead: Lead): string {
  const bits = [LEAD_STAGE_META[lead.stage].label];
  if (lead.owner_name) bits.push(`owned by ${lead.owner_name}`);
  else bits.push('unassigned');
  return bits.join(' · ');
}

function toInput(lead: Lead): LeadInput {
  return {
    cafe_name: lead.cafe_name,
    contact_name: lead.contact_name,
    email: lead.email ?? '',
    phone: lead.phone,
    source: lead.source,
    desired_plan: lead.desired_plan,
    expected_seats: lead.expected_seats ?? null,
    message: lead.message,
    notes: lead.notes,
    owner_person_id: lead.owner_person_id ?? null,
    next_follow_up_at: lead.next_follow_up_at ?? '',
  };
}

/** The stage stepper. Only open stages are offered — 'won' lives on the close
 *  panel and 'lost' needs a reason, so both get their own affordance. */
function StagePanel({ lead }: { lead: Lead }) {
  const update = useAdminUpdateLead(lead.id);
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  const closed = lead.stage === 'won' || lead.stage === 'lost';

  const move = (stage: LeadStage) => update.mutate({ ...toInput(lead), stage });

  if (closed) {
    const meta = LEAD_STAGE_META[lead.stage];
    return (
      <section className="panel">
        <div className="panel-head"><h3>Outcome</h3></div>
        <p>
          <span className={`pill ${meta.cls}`}>{meta.label}</span>{' '}
          <span className="muted">{lead.closed_at ? fmtDayLong(lead.closed_at) : ''}</span>
        </p>
        {lead.stage === 'lost' && lead.lost_reason && <p className="hint">{lead.lost_reason}</p>}
        {lead.converted_tenant_id && (
          <p style={{ marginTop: 8 }}>
            <Link className="btn" to={`/super/tenants/${lead.converted_tenant_id}`}>
              <Building2 size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
              Open {lead.converted_name ?? lead.converted_slug ?? 'the café'}
            </Link>
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head"><h3>Stage</h3></div>
      <div className="chips lead-stepper">
        {OPEN_LEAD_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip ${lead.stage === s ? 'on' : ''}`}
            disabled={update.isPending}
            onClick={() => move(s)}
          >
            {LEAD_STAGE_META[s].label}
          </button>
        ))}
        <button type="button" className="chip danger" onClick={() => setLosing(true)}>
          Mark lost
        </button>
      </div>

      <Modal
        open={losing}
        title={`Mark ${lead.cafe_name} lost?`}
        subtitle="It stays on the board so the work isn't erased — and so we know what we lose deals over."
        onClose={() => setLosing(false)}
      >
        <div className="field">
          <label>Why?</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="went with a competitor / no budget / closed down"
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setLosing(false)}>Cancel</button>
          <button
            className="btn danger"
            disabled={!reason.trim() || update.isPending}
            onClick={async () => {
              await update.mutateAsync({ ...toInput(lead), stage: 'lost', lost_reason: reason.trim() });
              setLosing(false);
            }}
          >
            Mark lost
          </button>
        </div>
      </Modal>
    </section>
  );
}

/** The stored value is a vocabulary key ("request_access"); never show it raw. */
function sourceLabel(source: Lead['source']): string {
  return ACQUISITION_SOURCES.find((s) => s.value === source)?.label ?? source;
}

function FactsPanel({ lead }: { lead: Lead }) {
  const tone = toneForDueDate(lead.next_follow_up_at);

  return (
    <section className="panel">
      <div className="panel-head"><h3>Details</h3></div>
      <dl className="super-dl">
        <dt>Contact</dt>
        <dd>{lead.contact_name || <span className="muted">—</span>}</dd>
        <dt>Email</dt>
        <dd>
          {lead.email ? <a href={`mailto:${lead.email}`}><Mail size={11} strokeWidth={1.8} /> {lead.email}</a>
            : <span className="muted">— none on file</span>}
        </dd>
        <dt>Phone</dt>
        <dd>
          {lead.phone ? <a href={`tel:${lead.phone}`}><Phone size={11} strokeWidth={1.8} /> {lead.phone}</a>
            : <span className="muted">—</span>}
        </dd>
        <dt>Source</dt><dd>{sourceLabel(lead.source)}</dd>
        <dt>Owner</dt><dd>{lead.owner_name || <span className="muted">unassigned</span>}</dd>
        <dt>Next follow-up</dt>
        <dd className={`lead-due lead-due--${tone}`}>
          {lead.next_follow_up_at ? fmtDay(lead.next_follow_up_at) : <span className="muted">not booked</span>}
        </dd>
        {lead.desired_plan && (<><dt>Wants</dt><dd>{lead.desired_plan}</dd></>)}
        {lead.expected_seats ? (<><dt>Seats</dt><dd>{lead.expected_seats}</dd></>) : null}
        <dt>Added</dt><dd>{fmtDay(lead.created_at)}</dd>
      </dl>
      {lead.message && (
        <>
          <p className="hint" style={{ marginTop: 12 }}>What they wrote on the form</p>
          <p className="lead-message">{lead.message}</p>
        </>
      )}
      {lead.notes && (
        <>
          <p className="hint" style={{ marginTop: 12 }}>Notes</p>
          <p className="lead-message">{lead.notes}</p>
        </>
      )}
    </section>
  );
}

/** Log a call/visit and book the next follow-up in one go — splitting those in
 *  two is how follow-ups get forgotten. */
function ActivityPanel({
  id,
  activities,
  readOnly,
  tenantId,
}: {
  id: string;
  activities: { id: string; kind: LeadActivityKind; body: string; occurred_at: string; author_name: string }[];
  readOnly?: boolean;
  tenantId?: string;
}) {
  const log = useAdminLogLeadActivity(id);
  const [kind, setKind] = useState<LeadActivityKind>('call');
  const [body, setBody] = useState('');
  const [next, setNext] = useState('');

  const submit = async () => {
    if (!body.trim()) return;
    await log.mutateAsync({
      kind,
      body: body.trim(),
      // Only send the field when a date was picked, so an untouched picker
      // can't clear a follow-up somebody already booked.
      ...(next ? { next_follow_up_at: next } : {}),
    });
    setBody('');
    setNext('');
  };

  return (
    <section className="panel">
      <div className="panel-head"><h3>Timeline</h3></div>

      {readOnly ? (
        <p className="hint">
          This lead is closed — anything new belongs on the café’s own notes
          {tenantId ? <> (<Link to={`/super/tenants/${tenantId}?tab=relationship`}>open them</Link>)</> : null}.
        </p>
      ) : (
        <div className="lead-log">
          <select value={kind} onChange={(e) => setKind(e.target.value as LeadActivityKind)}>
            {LOGGABLE_LEAD_ACTIVITIES.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="spoke to the owner — wants a demo next week"
          />
          <DatePicker value={next} onChange={setNext} placeholder="follow up on…" compact />
          <button className="btn" disabled={!body.trim() || log.isPending} onClick={() => void submit()}>
            <Plus size={14} strokeWidth={1.8} style={{ marginRight: 4 }} />
            {log.isPending ? 'Saving…' : 'Log'}
          </button>
        </div>
      )}

      {activities.length === 0 ? (
        <p className="hint">Nothing logged yet. Every call and visit recorded here is what makes the next one useful.</p>
      ) : (
        <ul className="lead-timeline">
          {activities.map((a) => (
            <li key={a.id} className={a.kind === 'stage_change' ? 'is-system' : undefined}>
              <span className="lead-timeline-kind">{LEAD_ACTIVITY_LABEL[a.kind]}</span>
              <div>
                <p>{a.body}</p>
                <span className="muted">
                  {a.author_name || 'someone'} · {fmtRelative(a.occurred_at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The two ways to win: provision a new café, or attach to one that already
 *  exists. Both hand this lead's attribution to the tenant. */
function ClosePanel({ lead }: { lead: Lead }) {
  const [mode, setMode] = useState<'convert' | 'link' | null>(null);

  return (
    <section className="panel">
      <div className="panel-head"><h3>Won it?</h3></div>
      <p className="hint">
        {lead.owner_name
          ? `${lead.owner_name} becomes the café's onboarder and relationship manager.`
          : 'This lead has no owner yet — you’ll be recorded as the onboarder.'}
      </p>
      <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
        <button className="btn primary" onClick={() => setMode('convert')}>Create the café</button>
        <button className="btn" onClick={() => setMode('link')}>Link an existing café</button>
      </div>

      {mode === 'convert' && <ConvertModal lead={lead} onClose={() => setMode(null)} />}
      {mode === 'link' && <LinkModal lead={lead} onClose={() => setMode(null)} />}
    </section>
  );
}

function ConvertModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const convert = useAdminConvertLead(lead.id);
  const plans = useAdminPlans();
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');
  const [planKey, setPlanKey] = useState(lead.desired_plan || 'trial');
  const [ownerEmail, setOwnerEmail] = useState(lead.email ?? '');

  const planOptions = (plans.data?.plans ?? []).filter((p) => p.active);

  return (
    <Modal
      open
      title={`Create ${lead.cafe_name}`}
      subtitle="Provisions a workspace and invites the owner."
      onClose={onClose}
    >
      {convert.isError && <div className="banner-error">{convert.error?.message ?? 'Could not convert'}</div>}
      <div className="field">
        <label>Owner email</label>
        <input
          type="email"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          placeholder="who should get the owner invite"
        />
        {!lead.email && (
          <div className="field-hint">This lead has no email on file, so the invite needs one here.</div>
        )}
      </div>
      <div className="field">
        <label>Slug (optional)</label>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="derived from the café name" />
      </div>
      <div className="field">
        <label>Plan</label>
        <select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
          {planOptions.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}{p.trial_days > 0 ? ` · ${p.trial_days}-day trial` : ''}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">
        The café inherits this lead’s source (<strong>{sourceLabel(lead.source)}</strong>)
        {lead.owner_name ? <> and its owner, <strong>{lead.owner_name}</strong>, as relationship manager</> : null}.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!ownerEmail.trim() || convert.isPending}
          onClick={async () => {
            const r = await convert.mutateAsync({
              slug: slug.trim() || undefined,
              plan_key: planKey,
              owner_email: ownerEmail.trim(),
            });
            onClose();
            navigate(`/super/tenants/${r.tenant_id}`);
          }}
        >
          {convert.isPending ? 'Provisioning…' : 'Create & win'}
        </button>
      </div>
    </Modal>
  );
}

function LinkModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const link = useAdminLinkLead(lead.id);
  const tenants = useAdminTenants();
  const [tenantId, setTenantId] = useState('');

  const options = (tenants.data?.tenants ?? []).map((t) => ({
    value: t.tenant_id,
    label: `${t.name} · /${t.slug}`,
  }));

  return (
    <Modal
      open
      title="Link an existing café"
      subtitle="For a café that was set up before anyone closed the lead."
      onClose={onClose}
    >
      {link.isError && <div className="banner-error">{link.error?.message ?? 'Could not link'}</div>}
      <div className="field">
        <label>Café</label>
        <SearchSelect options={options} value={tenantId} onChange={setTenantId} placeholder="search cafés…" />
      </div>
      <p className="hint">
        Relationship fields are filled in only where they’re still blank — a café that already has a
        relationship manager keeps them.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!tenantId || link.isPending}
          onClick={async () => {
            await link.mutateAsync({ tenant_id: tenantId });
            onClose();
          }}
        >
          {link.isPending ? 'Linking…' : 'Link & win'}
        </button>
      </div>
    </Modal>
  );
}
