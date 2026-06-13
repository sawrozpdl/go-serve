import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, FileText, Search, Users, UserCheck, UserX } from 'lucide-react';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { Tabs } from '@/components/Tabs';
import { StaffFormModal } from '@/components/StaffFormModal';
import { useStaffList, type Staff } from '@/lib/api';
import { Can } from '@/lib/permissions';

type StatusTab = 'active' | 'inactive';

export function StaffPage() {
  const staff = useStaffList();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<StatusTab>('active');

  const list = useMemo(() => staff.data ?? [], [staff.data]);

  const counts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    for (const s of list) (s.status === 'active' ? active++ : inactive++);
    return { active, inactive };
  }, [list]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return list.filter((s) => {
      if (s.status !== tab) return false;
      if (!term) return true;
      return (
        s.full_name.toLowerCase().includes(term) || s.role_title.toLowerCase().includes(term)
      );
    });
  }, [list, q, tab]);

  const tabs = (
    <Tabs<StatusTab>
      ariaLabel="Filter staff by status"
      active={tab}
      onChange={setTab}
      items={[
        {
          key: 'active',
          label: 'Active',
          icon: <UserCheck size={14} strokeWidth={1.6} />,
          badge: <span className="tab-count">{counts.active}</span>,
        },
        {
          key: 'inactive',
          label: 'Inactive',
          icon: <UserX size={14} strokeWidth={1.6} />,
          badge: <span className="tab-count">{counts.inactive}</span>,
        },
      ]}
    />
  );

  return (
    <PageShell
      eyebrow="people"
      title="Staff"
      tabs={list.length > 0 ? tabs : undefined}
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
      ) : staff.isError && !staff.data ? (
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
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name or role"
              />
            </div>
            <span className="meta-line">
              {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">
              {q.trim()
                ? `No one matches “${q}”.`
                : `No ${tab} staff.`}
            </div>
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
