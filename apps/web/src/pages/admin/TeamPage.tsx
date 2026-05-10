import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';

import { useMembers, useUpdateMemberRoles, type Member, type TenantRole } from '@/lib/api';

const ALL_ROLES: { value: TenantRole; label: string; hint: string }[] = [
  { value: 'owner', label: 'Owner', hint: 'full access; only one person should hold this' },
  { value: 'manager', label: 'Manager', hint: 'can void / discount, set PINs' },
  { value: 'waiter', label: 'Waiter', hint: 'opens tabs and takes orders' },
  { value: 'kitchen', label: 'Kitchen', hint: 'works the KDS, marks tickets ready' },
];

export function TeamPage() {
  const list = useMembers();

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">people</span>
          <h1>team.</h1>
        </div>
        <span className="meta-line">{list.data?.length ?? 0} members</span>
      </div>

      <div className="panel">
        {list.isPending && <div className="empty-state">loading…</div>}
        {list.data?.length === 0 && (
          <div className="empty-state">no team members yet.</div>
        )}
        {list.data && list.data.length > 0 && (
          <div className="member-list">
            {list.data.map((m) => (
              <MemberRow key={m.user_id} member={m} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function MemberRow({ member }: { member: Member }) {
  const update = useUpdateMemberRoles();
  const [roles, setRoles] = useState<TenantRole[]>(member.roles);
  const [err, setErr] = useState<string | null>(null);
  const lastServerRoles = useRef<string>(member.roles.join(','));

  // When the server roles change (e.g. another tab updated the member),
  // resync our local state — but only when the user hasn't pending edits.
  useEffect(() => {
    const serverKey = member.roles.join(',');
    if (serverKey !== lastServerRoles.current) {
      setRoles(member.roles);
      lastServerRoles.current = serverKey;
    }
  }, [member.roles]);

  const toggle = (ro: TenantRole) => {
    setErr(null);
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

  return (
    <div className="member-row">
      <div className="member-id">
        <strong>{member.name || member.email}</strong>
        <span className="meta">{member.email}</span>
        <span className={`pill ${member.status === 'active' ? 'ok' : ''}`}>{member.status}</span>
      </div>
      <div className="member-roles">
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
