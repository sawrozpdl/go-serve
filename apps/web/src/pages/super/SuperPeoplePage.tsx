import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Phone, Mail, ShieldCheck, UserPlus, UserMinus } from 'lucide-react';

import {
  useAdminPeople,
  useAdminPerson,
  useAdminCreatePerson,
  useAdminUpdatePerson,
  useAdminPlatformAdmins,
  useAdminAddPlatformAdmin,
  useAdminRemovePlatformAdmin,
  useMe,
  type PlatformPerson,
  type PersonInput,
} from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { Modal } from '@/components/Modal';
import { Drawer } from '@/components/Drawer';
import { useConfirm } from '@/components/ConfirmDialog';
import { fmtDay } from '@/lib/dates';

const KIND_LABEL: Record<PlatformPerson['kind'], string> = {
  admin: 'Team',
  agent: 'Field agent',
  partner: 'Partner',
};

const EMPTY: PersonInput = { name: '', kind: 'agent', email: '', phone: '', notes: '', active: true };

/* The registry of humans behind the platform: our own team plus the outside
 * market agents and partners who sign cafes up. Console access is shown here
 * too, but it is a SEPARATE thing (platform_admins) — being in this list grants
 * nothing, which is exactly why an agent can exist here with no login at all. */
export function SuperPeoplePage() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const q = useAdminPeople(includeInactive);
  const create = useAdminCreatePerson();
  const [editing, setEditing] = useState<PlatformPerson | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const people = q.data?.people ?? [];

  return (
    <PageShell
      eyebrow="Platform"
      title="People"
      subtitle="Who onboards and looks after each café"
      docTitle="People"
      actions={
        <>
          <button
            type="button"
            className={`chip ${includeInactive ? 'on' : ''}`}
            onClick={() => setIncludeInactive((v) => !v)}
          >
            Show inactive
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> Add person
          </button>
        </>
      }
    >
      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={people.length === 0}
        errorTitle="Could not load the people registry"
        emptyTitle="Nobody in the registry yet"
        emptyHint="Add the team members and field agents who bring cafés on board, so every workspace has an owner."
      >
        <div className="table-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Contact</th>
                <th className="num">Onboarded</th>
                <th className="num">Managing</th>
                <th>Console</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className={p.active ? undefined : 'row-muted'}>
                  <td>
                    <button type="button" className="linklike" onClick={() => setOpenId(p.id)}>
                      <strong>{p.name}</strong>
                    </button>
                    {!p.active && <span className="pill" style={{ marginLeft: 6 }}>inactive</span>}
                  </td>
                  <td>{KIND_LABEL[p.kind]}</td>
                  <td>
                    <div className="person-contact">
                      {p.email && <span><Mail size={11} strokeWidth={1.8} /> {p.email}</span>}
                      {p.phone && <span><Phone size={11} strokeWidth={1.8} /> {p.phone}</span>}
                      {!p.email && !p.phone && <span className="muted">—</span>}
                    </div>
                  </td>
                  <td className="num">{p.cafes_onboarded || <span className="muted">0</span>}</td>
                  <td className="num">{p.cafes_managed || <span className="muted">0</span>}</td>
                  <td>
                    {p.console_access ? (
                      <span className="pill ok"><ShieldCheck size={11} strokeWidth={2} /> yes</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="super-row-actions">
                    <button className="btn icon" title="Edit" onClick={() => setEditing(p)}>
                      <Pencil size={14} strokeWidth={1.7} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      {creating && (
        <PersonModal
          title="Add person"
          subtitle="A field agent needs nothing but a name — email and login are optional."
          initial={EMPTY}
          busy={create.isPending}
          onClose={() => setCreating(false)}
          onSave={async (input) => { await create.mutateAsync(input); setCreating(false); }}
        />
      )}
      {editing && <PersonEditModal person={editing} onClose={() => setEditing(null)} />}
      {openId && <PersonDrawer id={openId} onClose={() => setOpenId(null)} />}
    </PageShell>
  );
}

function PersonEditModal({ person, onClose }: { person: PlatformPerson; onClose: () => void }) {
  const update = useAdminUpdatePerson(person.id);
  return (
    <PersonModal
      title={`Edit ${person.name}`}
      initial={{
        name: person.name,
        kind: person.kind,
        email: person.email ?? '',
        phone: person.phone,
        notes: person.notes,
        active: person.active,
      }}
      busy={update.isPending}
      showActive
      onClose={onClose}
      onSave={async (input) => { await update.mutateAsync(input); onClose(); }}
    />
  );
}

function PersonModal({
  title,
  subtitle,
  initial,
  busy,
  showActive = false,
  onClose,
  onSave,
}: {
  title: string;
  subtitle?: string;
  initial: PersonInput;
  busy: boolean;
  showActive?: boolean;
  onClose: () => void;
  onSave: (input: PersonInput) => Promise<void>;
}) {
  const [form, setForm] = useState<PersonInput>(initial);
  const canSave = form.name.trim() !== '' && !busy;

  return (
    <Modal open title={title} subtitle={subtitle} onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
      </div>
      <div className="field">
        <label>Type</label>
        <select
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as PlatformPerson['kind'] })}
        >
          <option value="agent">Field agent — signs cafés up out in the market</option>
          <option value="admin">Team — one of us</option>
          <option value="partner">Partner — reseller or referral source</option>
        </select>
      </div>
      <div className="field">
        <label>Email (optional)</label>
        <input
          type="email"
          value={form.email ?? ''}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="leave blank if they don't have one"
        />
        <div className="field-hint">
          If this matches someone who has signed in, they’re linked automatically — that only makes
          granting console access easier later, it doesn’t grant anything now.
        </div>
      </div>
      <div className="field">
        <label>Phone</label>
        <input
          type="tel"
          value={form.phone ?? ''}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="+977 …"
        />
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea
          rows={2}
          value={form.notes ?? ''}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="territory, arrangement, anything worth remembering"
        />
      </div>
      {showActive && (
        <label className="super-check">
          <input
            type="checkbox"
            checked={form.active !== false}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          Active — uncheck to retire them. Cafés they onboarded keep the attribution.
        </label>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!canSave} onClick={() => void onSave(form)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

/** Drill-down: everything one person is responsible for, plus the console
 *  access toggle (which writes to platform_admins, not to the registry). */
function PersonDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAdminPerson(id);
  const p = q.data?.person;

  return (
    <Drawer open title={p?.name ?? 'Person'} subtitle={p ? KIND_LABEL[p.kind] : undefined} onClose={onClose}>
      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        errorTitle="Could not load this person"
        compact
      >
        {p && (
          <>
            <dl className="super-dl">
              <dt>Email</dt><dd>{p.email ?? <span className="muted">— none on file</span>}</dd>
              <dt>Phone</dt><dd>{p.phone || <span className="muted">—</span>}</dd>
              <dt>Added</dt><dd>{fmtDay(p.created_at)}</dd>
              {p.notes && (<><dt>Notes</dt><dd>{p.notes}</dd></>)}
            </dl>

            <ConsoleAccessRow person={p} />

            <PortfolioList
              title="Manages"
              hint="Cafés this person is the relationship manager for."
              cafes={q.data?.cafes ?? []}
              onNavigate={onClose}
            />
            <PortfolioList
              title="Onboarded"
              hint="Cafés they signed up — some may be managed by someone else now."
              cafes={q.data?.onboards ?? []}
              onNavigate={onClose}
            />
          </>
        )}
      </QueryState>
    </Drawer>
  );
}

/** Console access lives in platform_admins. Showing it here keeps the two ideas
 *  visibly separate: this row is the only thing on the page that grants power. */
function ConsoleAccessRow({ person }: { person: PlatformPerson }) {
  const me = useMe();
  const admins = useAdminPlatformAdmins();
  const grant = useAdminAddPlatformAdmin();
  const revoke = useAdminRemovePlatformAdmin();
  const confirm = useConfirm();

  const isSelf = person.user_id != null && person.user_id === me.data?.user_id;
  const knownUser = admins.data?.admins.some((a) => a.user_id === person.user_id);

  if (!person.email) {
    return (
      <p className="hint">
        No email on file, so this person can’t be given console access. That’s expected for a field
        agent — they don’t need an account to be credited with a café.
      </p>
    );
  }

  const onGrant = async () => {
    if (await confirm({
      title: `Give ${person.name} console access?`,
      message: 'They get full cross-tenant access to every café, payment and setting. They must have signed in at least once.',
      confirmLabel: 'Grant access',
    })) {
      grant.mutate({ email: person.email! });
    }
  };

  const onRevoke = async () => {
    if (!person.user_id) return;
    if (await confirm({
      title: `Revoke console access from ${person.name}?`,
      danger: true,
      confirmLabel: 'Revoke',
    })) {
      revoke.mutate(person.user_id);
    }
  };

  return (
    <div className="field">
      <label>Console access</label>
      {person.console_access ? (
        <button
          className="btn danger"
          disabled={isSelf || revoke.isPending}
          title={isSelf ? 'You can’t revoke your own access' : undefined}
          onClick={onRevoke}
        >
          <UserMinus size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Revoke access
        </button>
      ) : (
        <button className="btn" disabled={grant.isPending} onClick={onGrant}>
          <UserPlus size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Grant access
        </button>
      )}
      {!knownUser && !person.console_access && (
        <div className="field-hint">They must sign in once before access can be granted.</div>
      )}
    </div>
  );
}

function PortfolioList({
  title,
  hint,
  cafes,
  onNavigate,
}: {
  title: string;
  hint: string;
  cafes: { tenant_id: string; slug: string; name: string; status: string; plan_name?: string }[];
  onNavigate: () => void;
}) {
  return (
    <section style={{ marginTop: 'var(--space-5)' }}>
      <div className="panel-head">
        <h3>{title} <span className="muted">({cafes.length})</span></h3>
      </div>
      <p className="hint">{hint}</p>
      {cafes.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="person-cafes">
          {cafes.map((c) => (
            <li key={c.tenant_id}>
              <Link to={`/super/tenants/${c.tenant_id}`} onClick={onNavigate}>
                <strong>{c.name}</strong>
                <em>{c.slug}</em>
              </Link>
              <span className="muted">{c.plan_name ?? '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
