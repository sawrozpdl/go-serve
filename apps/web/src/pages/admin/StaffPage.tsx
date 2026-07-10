import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, FileText, Search, Users, CalendarRange } from 'lucide-react';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { Tabs } from '@/components/Tabs';
import { StaffFormModal } from '@/components/StaffFormModal';
import { StaffTimeline } from '@/components/StaffTimeline';
import { useStaffList, useMe, hasFeature, type Staff } from '@/lib/api';
import { Can } from '@/lib/permissions';

type View = 'roster' | 'timeline';
type StatusFilter = 'active' | 'inactive';

export function StaffPage() {
  const staff = useStaffList();
  const me = useMe();
  // The shift Timeline (roster scheduling) is the gated staff_scheduling
  // feature; the Roster list itself is part of staff_hr (already gating this
  // whole page).
  const scheduling = hasFeature(me.data, 'staff_scheduling');
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('roster');
  const [status, setStatus] = useState<StatusFilter>('active');

  const list = useMemo(() => staff.data ?? [], [staff.data]);

  const counts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    for (const s of list) (s.status === 'active' ? active++ : inactive++);
    return { active, inactive };
  }, [list]);

  const activeStaff = useMemo(() => list.filter((s) => s.status === 'active'), [list]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return list.filter((s) => {
      if (s.status !== status) return false;
      if (!term) return true;
      return (
        s.full_name.toLowerCase().includes(term) || s.role_title.toLowerCase().includes(term)
      );
    });
  }, [list, q, status]);

  const tabs = scheduling ? (
    <Tabs<View>
      ariaLabel="Staff views"
      active={view}
      onChange={setView}
      items={[
        { key: 'roster', label: 'Roster', icon: <Users size={14} strokeWidth={1.6} /> },
        { key: 'timeline', label: 'Timeline', icon: <CalendarRange size={14} strokeWidth={1.6} /> },
      ]}
    />
  ) : undefined;

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
      ) : view === 'timeline' ? (
        <StaffTimeline staff={activeStaff} />
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
            <div className="staff-statusfilter">
              <button
                className={`chip ${status === 'active' ? 'active' : ''}`}
                onClick={() => setStatus('active')}
              >
                Active <span className="chip-count">{counts.active}</span>
              </button>
              <button
                className={`chip ${status === 'inactive' ? 'active' : ''}`}
                onClick={() => setStatus('inactive')}
              >
                Inactive <span className="chip-count">{counts.inactive}</span>
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">
              {q.trim() ? `No one matches “${q}”.` : `No ${status} staff.`}
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
    <Link to={`/admin/people/staff/${s.id}`} className="staff-card">
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
