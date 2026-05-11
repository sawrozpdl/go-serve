import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Save, Send, X } from 'lucide-react';

import {
  useMembers,
  useUpdateMemberRoles,
  useInvites,
  useCreateInvite,
  useRevokeInvite,
  useMe,
  type Member,
  type Invite,
  type TenantRole,
} from '@/lib/api';

const ALL_ROLES: { value: TenantRole; label: string; hint: string }[] = [
  { value: 'owner', label: 'Owner', hint: 'full access; at least one owner is always required' },
  { value: 'manager', label: 'Manager', hint: 'can void / discount, set PINs' },
  { value: 'waiter', label: 'Waiter', hint: 'opens tabs and takes orders' },
  { value: 'kitchen', label: 'Kitchen', hint: 'works the KDS, marks tickets ready' },
];

export function TeamPage() {
  const members = useMembers();
  const invites = useInvites();

  // Active owners — used to lock the last owner's "owner" chip in the UI
  // so the user sees the constraint before the API enforces it.
  const activeOwnerCount = (members.data ?? []).filter(
    (m) => m.status === 'active' && m.roles.includes('owner'),
  ).length;

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">people</span>
          <h1>Team</h1>
        </div>
        <span className="meta-line">
          {members.data?.length ?? 0} members
          {invites.data && invites.data.length > 0 ? ` · ${invites.data.length} pending` : ''}
        </span>
      </div>

      <div className="panel">
        <InviteForm />
      </div>

      {invites.data && invites.data.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Pending invites</h3>
          <div className="member-list">
            {invites.data.map((inv) => (
              <InviteRow key={inv.id} invite={inv} />
            ))}
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Members</h3>
        {members.isPending && <div className="empty-state">loading…</div>}
        {members.data?.length === 0 && (
          <div className="empty-state">no team members yet.</div>
        )}
        {members.data && members.data.length > 0 && (
          <div className="member-list">
            {members.data.map((m) => (
              <MemberRow
                key={m.user_id}
                member={m}
                activeOwnerCount={activeOwnerCount}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function InviteForm() {
  const create = useCreateInvite();
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<TenantRole[]>(['waiter']);

  const toggle = (r: TenantRole) =>
    setRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || roles.length === 0) return;
    try {
      await create.mutateAsync({ email: email.trim(), roles });
      setEmail('');
      setRoles(['waiter']);
    } catch {
      /* surfaced via create.error */
    }
  };

  return (
    <form onSubmit={onSubmit}>
      <h3 style={{ marginTop: 0 }}>Invite someone</h3>
      <p className="meta" style={{ marginTop: -8, marginBottom: 12 }}>
        Enter their work email. When they sign in with Google using that
        address, they'll be added to this workspace automatically.
      </p>
      {create.isError && (
        <div className="banner-error">{create.error?.message ?? 'Could not send invite'}</div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 240px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-300)',
              marginBottom: 6,
            }}
          >
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            required
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-300)',
              marginBottom: 6,
            }}
          >
            Roles
          </label>
          <div className="member-roles" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ALL_ROLES.map((r) => {
              const on = roles.includes(r.value);
              return (
                <button
                  type="button"
                  key={r.value}
                  className={`role-chip ${on ? 'active' : ''}`}
                  onClick={() => toggle(r.value)}
                  title={r.hint}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="submit"
          className="btn primary"
          disabled={create.isPending || !email.trim() || roles.length === 0}
          style={{ alignSelf: 'flex-end' }}
        >
          <Send size={14} strokeWidth={1.5} />
          {create.isPending ? 'Inviting…' : 'Send invite'}
        </button>
      </div>
    </form>
  );
}

function InviteRow({ invite }: { invite: Invite }) {
  const revoke = useRevokeInvite();
  return (
    <div className="member-row">
      <div className="member-id">
        <strong>{invite.email}</strong>
        <span className="meta">invited {new Date(invite.invited_at).toLocaleDateString()}</span>
        <span className="pill">pending</span>
      </div>
      <div className="member-roles">
        {invite.roles.map((r) => (
          <span key={r} className="role-chip active" style={{ cursor: 'default' }}>
            {r}
          </span>
        ))}
      </div>
      <div className="member-save">
        <button
          type="button"
          className="btn danger"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate(invite.id)}
          title="Revoke this invite"
        >
          <X size={14} strokeWidth={1.5} />
          Revoke
        </button>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  activeOwnerCount,
}: {
  member: Member;
  activeOwnerCount: number;
}) {
  const me = useMe();
  const update = useUpdateMemberRoles();
  const [roles, setRoles] = useState<TenantRole[]>(member.roles);
  const [err, setErr] = useState<string | null>(null);
  const lastServerRoles = useRef<string>(member.roles.join(','));

  useEffect(() => {
    const serverKey = member.roles.join(',');
    if (serverKey !== lastServerRoles.current) {
      setRoles(member.roles);
      lastServerRoles.current = serverKey;
    }
  }, [member.roles]);

  const memberIsLastOwner =
    member.status === 'active' &&
    member.roles.includes('owner') &&
    activeOwnerCount <= 1;

  const toggle = (ro: TenantRole) => {
    setErr(null);
    // Pre-flight: refuse to drop 'owner' from the last owner.
    if (
      ro === 'owner' &&
      roles.includes('owner') &&
      memberIsLastOwner
    ) {
      setErr('a workspace must always have at least one owner — promote someone else first');
      return;
    }
    setRoles((prev) =>
      prev.includes(ro) ? prev.filter((r) => r !== ro) : [...prev, ro],
    );
  };

  const dirty =
    roles.length !== member.roles.length ||
    roles.some((r) => !member.roles.includes(r));

  const onSave = async () => {
    setErr(null);
    if (roles.length === 0) {
      setErr('at least one role is required');
      return;
    }
    try {
      await update.mutateAsync({ userId: member.user_id, roles });
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  const isSelf = me.data?.user_id === member.user_id;

  return (
    <div className="member-row">
      <div className="member-id">
        <strong>
          {member.name || member.email}
          {isSelf && <span className="meta" style={{ marginLeft: 6 }}>(you)</span>}
        </strong>
        <span className="meta">{member.email}</span>
        <span className={`pill ${member.status === 'active' ? 'ok' : ''}`}>{member.status}</span>
      </div>
      <div className="member-roles">
        {ALL_ROLES.map((r) => {
          const on = roles.includes(r.value);
          // Disable removing 'owner' from the last owner in the UI; the
          // backend enforces this too — this just makes it obvious.
          const lockedOwner =
            r.value === 'owner' && on && memberIsLastOwner;
          return (
            <button
              type="button"
              key={r.value}
              className={`role-chip ${on ? 'active' : ''}`}
              onClick={() => toggle(r.value)}
              disabled={lockedOwner}
              title={lockedOwner ? 'last owner — promote someone else first' : r.hint}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      {err && <div className="banner-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
      <div className="member-save">
        <button
          type="button"
          className="btn primary"
          disabled={!dirty || update.isPending}
          onClick={onSave}
        >
          <Save size={14} strokeWidth={1.5} />
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
