import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, FileText, Search, Users } from 'lucide-react';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { StaffFormModal } from '@/components/StaffFormModal';
import { useStaffList, type Staff } from '@/lib/api';
import { Can } from '@/lib/permissions';

export function StaffPage() {
  const staff = useStaffList();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const list = useMemo(() => staff.data ?? [], [staff.data]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return list;
    return list.filter(
      (s) => s.full_name.toLowerCase().includes(term) || s.role_title.toLowerCase().includes(term),
    );
  }, [list, q]);

  return (
    <PageShell
      eyebrow="people"
      title="Staff"
      actions={
        <Can perm="staff:create">
          <button className="btn primary" onClick={() => setCreating(true)}>
            <UserPlus size={15} /> Add staff
          </button>
        </Can>
      }
    >
      {staff.isPending ? (
        <LoadingState />
      ) : staff.isError ? (
        <ErrorState onRetry={() => staff.refetch()} />
      ) : list.length === 0 ? (
        <div className="panel staff-empty">
          <Users size={28} strokeWidth={1.5} />
          <h3>No staff yet</h3>
          <p>Add your team members, then attach their documents — citizenship, licence and more.</p>
          <Can perm="staff:create">
            <button className="btn primary" onClick={() => setCreating(true)}>
              <UserPlus size={15} /> Add staff
            </button>
          </Can>
        </div>
      ) : (
        <>
          <div className="staff-toolbar">
            <div className="staff-search">
              <Search size={15} strokeWidth={1.5} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or role" />
            </div>
            <span className="meta-line">
              {list.length} {list.length === 1 ? 'person' : 'people'}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">No one matches “{q}”.</div>
          ) : (
            <div className="staff-grid">
              {filtered.map((s) => (
                <StaffCard key={s.id} s={s} />
              ))}
            </div>
          )}
        </>
      )}

      {creating && <StaffFormModal open onClose={() => setCreating(false)} />}
    </PageShell>
  );
}

function StaffCard({ s }: { s: Staff }) {
  const initials =
    s.full_name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';

  return (
    <Link to={`/admin/staff/${s.id}`} className="staff-card">
      <div className="staff-card__avatar">{initials}</div>
      <div className="staff-card__body">
        <div className="staff-card__name">{s.full_name}</div>
        <div className="staff-card__role">{s.role_title || 'Staff'}</div>
        <div className="staff-card__meta">
          <span className={`staff-status staff-status--${s.status}`}>{s.status}</span>
          <span className="staff-card__docs" title={`${s.doc_count} document(s)`}>
            <FileText size={13} strokeWidth={1.5} /> {s.doc_count}
          </span>
        </div>
      </div>
    </Link>
  );
}
