import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Save, Send, X, UserMinus } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { useConfirm } from '@/components/ConfirmDialog';
import {
  useMembers,
  useUpdateMemberRoles,
  useRemoveMember,
  useInvites,
  useCreateInvite,
  useRevokeInvite,
  useMe,
  useRoles,
  type Member,
  type Invite,
  type Role,
  type TenantRole,
} from '@/lib/api';
import { toast } from '@/lib/toast';

export function TeamPage() {
  const members = useMembers();
  const invites = useInvites();
  const roles = useRoles();
  const rolesByKey: Record<string, Role> = {};
  for (const r of roles.data ?? []) rolesByKey[r.key] = r;

  // Active owners — used to lock the last owner's "owner" chip in the UI
  // so the user sees the constraint before the API enforces it.
  const activeOwnerCount = (members.data ?? []).filter(
    (m) => m.status === 'active' && m.roles.includes('owner'),
  ).length;

  return (
    <PageShell
      eyebrow="people"
      title="Team"
      actions={
        <span className="meta-line">
          {members.data?.length ?? 0} members
          {invites.data && invites.data.length > 0 ? ` · ${invites.data.length} pending` : ''}
        </span>
      }
    >
      <div className="panel">
        <InviteForm allRoles={roles.data ?? []} />
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
        {members.isPending && <div className="empty-state">Loading…</div>}
        {members.data?.length === 0 && (
          <div className="empty-state">No team members yet.</div>
        )}
        {members.data && members.data.length > 0 && (
          <div className="member-list">
            {members.data.map((m) => (
              <MemberRow
                key={m.user_id}
                member={m}
                activeOwnerCount={activeOwnerCount}
                allRoles={roles.data ?? []}
                rolesByKey={rolesByKey}
              />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function InviteForm({ allRoles }: { allRoles: Role[] }) {
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
          <label className="form-label">Email</label>
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
          <label className="form-label">Roles</label>
          <div className="member-roles" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allRoles.map((r) => {
              const on = roles.includes(r.key);
              return (
                <button
                  type="button"
                  key={r.key}
                  className={`role-chip ${on ? 'active' : ''}`}
                  onClick={() => toggle(r.key)}
                  title={r.description}
                >
                  {r.name}
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
  allRoles,
  rolesByKey: _rolesByKey,
}: {
  member: Member;
  activeOwnerCount: number;
  allRoles: Role[];
  rolesByKey: Record<string, Role>;
}) {
  const me = useMe();
  const update = useUpdateMemberRoles();
  const remove = useRemoveMember();
  const confirm = useConfirm();
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
  const canRemove = !isSelf && !memberIsLastOwner;

  const onRemove = async () => {
    const ok = await confirm({
      title: `Remove ${member.name || member.email}?`,
      message: (
        <>
          They will lose access to this workspace. Historical records (orders,
          shifts, audit log) remain intact and reference their name. You can
          re-invite them later.
        </>
      ),
      danger: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setErr(null);
    try {
      await remove.mutateAsync({ userId: member.user_id });
      toast.success('Member removed', member.name || member.email);
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? 'Failed';
      setErr(msg);
      toast.error('Could not remove', msg);
    }
  };

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
        {allRoles.map((r) => {
          const on = roles.includes(r.key);
          const lockedOwner = r.key === 'owner' && on && memberIsLastOwner;
          return (
            <button
              type="button"
              key={r.key}
              className={`role-chip ${on ? 'active' : ''}`}
              onClick={() => toggle(r.key)}
              disabled={lockedOwner}
              title={lockedOwner ? 'last owner — promote someone else first' : r.description}
            >
              {r.name}
            </button>
          );
        })}
      </div>
      {err && <div className="banner-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
      <div className="member-save" style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={!dirty || update.isPending}
          onClick={onSave}
        >
          <Save size={14} strokeWidth={1.5} />
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
        {canRemove && (
          <button
            type="button"
            className="btn danger"
            disabled={remove.isPending}
            onClick={onRemove}
            title={
              isSelf
                ? 'You cannot remove yourself'
                : memberIsLastOwner
                  ? 'Last owner — promote someone else first'
                  : 'Remove from workspace'
            }
          >
            <UserMinus size={14} strokeWidth={1.5} />
            {remove.isPending ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
    </div>
  );
}
