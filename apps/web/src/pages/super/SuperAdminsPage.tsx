import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import {
  useAdminPlatformAdmins,
  useAdminAddPlatformAdmin,
  useAdminRemovePlatformAdmin,
  useMe,
} from '@/lib/api';
import { useConfirm } from '@/components/ConfirmDialog';

export function SuperAdminsPage() {
  const q = useAdminPlatformAdmins();
  const me = useMe();
  const add = useAdminAddPlatformAdmin();
  const remove = useAdminRemovePlatformAdmin();
  const confirm = useConfirm();
  const [email, setEmail] = useState('');

  const admins = q.data?.admins ?? [];

  const onAdd = async () => {
    if (!email.trim()) return;
    try {
      await add.mutateAsync({ email: email.trim() });
      setEmail('');
    } catch {
      /* surfaced via add.error */
    }
  };

  const onRemove = async (userId: string, who: string) => {
    if (await confirm({ title: `Revoke super-admin from ${who}?`, danger: true, confirmLabel: 'Revoke' })) {
      remove.mutate(userId);
    }
  };

  return (
    <div className="super-page">
      <div className="super-page-head">
        <div>
          <span className="super-eyebrow">Access</span>
          <h1>Platform admins</h1>
        </div>
      </div>

      {(q.isError || add.isError || remove.isError) && (
        <div className="banner-error">{q.error?.message ?? add.error?.message ?? remove.error?.message}</div>
      )}

      <section className="panel" style={{ maxWidth: 520 }}>
        <div className="field">
          <label>Add admin by email</label>
          <p className="hint" style={{ marginTop: -2 }}>The person must have signed in at least once.</p>
          <div className="super-inline">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@company.com" />
            <button className="btn primary" onClick={onAdd} disabled={add.isPending || !email.trim()}>
              <Plus size={14} strokeWidth={1.8} style={{ marginRight: 4 }} /> Add
            </button>
          </div>
        </div>
      </section>

      <div className="table-scroll" style={{ marginTop: 16 }}>
        <table className="t">
          <thead><tr><th>Name</th><th>Email</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {admins.map((a) => {
              const isSelf = a.user_id === me.data?.user_id;
              return (
                <tr key={a.user_id}>
                  <td>{a.name || '—'}{isSelf && <span className="muted"> (you)</span>}</td>
                  <td>{a.email}</td>
                  <td><span className="pill">{a.source === 'env_allowlist' ? 'env allowlist' : 'manual'}</span></td>
                  <td className="super-row-actions">
                    <button
                      className="btn icon"
                      title={isSelf ? "You can't remove yourself" : 'Revoke'}
                      disabled={isSelf || remove.isPending}
                      onClick={() => onRemove(a.user_id, a.email)}
                    >
                      <Trash2 size={14} strokeWidth={1.7} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
