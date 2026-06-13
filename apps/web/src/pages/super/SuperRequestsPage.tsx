import { useState } from 'react';
import { Check, X, Phone, Mail } from 'lucide-react';

import {
  useAdminTenantRequests,
  useAdminApproveRequest,
  useAdminRejectRequest,
  type AdminTenantRequest,
} from '@/lib/api';
import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';

function fmtDate(s?: string) {
  return s ? new Date(s).toLocaleString() : '—';
}

export function SuperRequestsPage() {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const q = useAdminTenantRequests(filter === 'all' ? undefined : 'pending');
  const approve = useAdminApproveRequest();
  const reject = useAdminRejectRequest();
  const confirm = useConfirm();

  const [approving, setApproving] = useState<AdminTenantRequest | null>(null);
  const [slug, setSlug] = useState('');
  const [planKey, setPlanKey] = useState('trial');

  const openApprove = (r: AdminTenantRequest) => {
    setApproving(r);
    setSlug('');
    setPlanKey(r.desired_plan || 'trial');
  };

  const doApprove = async () => {
    if (!approving) return;
    try {
      await approve.mutateAsync({ id: approving.id, slug: slug.trim() || undefined, plan_key: planKey });
      setApproving(null);
    } catch {
      /* surfaced via approve.error */
    }
  };

  const doReject = async (r: AdminTenantRequest) => {
    if (await confirm({ title: `Reject ${r.cafe_name}?`, message: `Decline the request from ${r.email}.`, danger: true, confirmLabel: 'Reject' })) {
      reject.mutate({ id: r.id });
    }
  };

  const requests = q.data?.requests ?? [];

  return (
    <div className="super-page">
      <div className="super-page-head">
        <div>
          <span className="super-eyebrow">Onboarding</span>
          <h1>Access requests</h1>
        </div>
        <div className="chips">
          <button className={`chip ${filter === 'pending' ? 'on' : ''}`} onClick={() => setFilter('pending')}>Pending</button>
          <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>

      {q.isError && <div className="banner-error">{q.error?.message ?? 'Failed to load requests'}</div>}

      <div className="super-requests">
        {requests.map((r) => (
          <div key={r.id} className="panel super-request">
            <div className="super-request-main">
              <div className="super-request-title">
                <strong>{r.cafe_name}</strong>
                <span className={`pill ${r.state === 'pending' ? '' : r.state === 'approved' ? 'ok' : ''}`}>{r.state}</span>
                {r.desired_plan && <span className="muted">wants: {r.desired_plan}</span>}
              </div>
              <div className="super-request-meta">
                <span>{r.name}</span>
                <a href={`mailto:${r.email}`}><Mail size={12} strokeWidth={1.8} /> {r.email}</a>
                {r.phone && <span><Phone size={12} strokeWidth={1.8} /> {r.phone}</span>}
                <span className="muted">{fmtDate(r.created_at)}</span>
              </div>
              {r.message && <p className="super-request-msg">{r.message}</p>}
            </div>
            {r.state === 'pending' && (
              <div className="super-request-actions">
                <button className="btn primary" onClick={() => openApprove(r)}><Check size={14} strokeWidth={1.8} style={{ marginRight: 4 }} /> Approve</button>
                <button className="btn danger" onClick={() => doReject(r)}><X size={14} strokeWidth={1.8} style={{ marginRight: 4 }} /> Reject</button>
              </div>
            )}
          </div>
        ))}
        {!q.isPending && requests.length === 0 && <div className="empty-state">No {filter === 'pending' ? 'pending ' : ''}requests.</div>}
      </div>

      <Modal open={!!approving} title={`Approve ${approving?.cafe_name ?? ''}`} subtitle="Provisions a workspace and invites the owner." onClose={() => setApproving(null)}>
        {approve.isError && <div className="banner-error">{approve.error?.message ?? 'Could not approve'}</div>}
        <p className="hint">Owner invite goes to <strong>{approving?.email}</strong>.</p>
        <div className="field"><label>Slug (optional)</label><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="derived from cafe name" /></div>
        <div className="field">
          <label>Plan</label>
          <select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            <option value="trial">Trial (90 days)</option>
            <option value="standard">Standard</option>
            <option value="growth">Growth</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setApproving(null)}>Cancel</button>
          <button className="btn primary" onClick={doApprove} disabled={approve.isPending}>{approve.isPending ? 'Provisioning…' : 'Approve & provision'}</button>
        </div>
      </Modal>
    </div>
  );
}
