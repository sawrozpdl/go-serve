// Shared "manager approval" inputs. Used inside void + discount modals.
// Hidden when the actor is owner|manager — the API will accept the action
// without approver fields.

import { useMe, hasAnyRole } from '@/lib/api';

type Props = {
  email: string;
  pin: string;
  onChange: (next: { email: string; pin: string }) => void;
};

export function ApprovalFields({ email, pin, onChange }: Props) {
  const me = useMe();
  const isManager = hasAnyRole(me.data, 'owner', 'manager');

  return (
    <div style={{ marginTop: 8, padding: '12px 14px', background: 'var(--ink-1000)', borderRadius: 2, border: '1px solid var(--ink-800)' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-300)',
          marginBottom: 8,
        }}
      >
        {isManager ? 'manager approval (your role allows this)' : 'manager approval'}
      </div>
      {isManager ? (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-400)' }}>
          you'll be recorded as the approver.
        </div>
      ) : (
        <>
          <label>Manager email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => onChange({ email: e.target.value, pin })}
            placeholder="manager@…"
            autoComplete="off"
          />
          <label>PIN</label>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => onChange({ email, pin: e.target.value })}
            autoComplete="off"
            maxLength={8}
          />
        </>
      )}
    </div>
  );
}
