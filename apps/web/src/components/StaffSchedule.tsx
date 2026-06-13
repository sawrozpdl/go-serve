import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, CalendarClock } from 'lucide-react';

import { WeeklyHoursGrid } from '@/components/WeeklyHoursGrid';
import { useUpdateStaff, type Staff, type StaffSchedule as Schedule } from '@/lib/api';
import { toast } from '@/lib/toast';
import { Can, usePermissions } from '@/lib/permissions';

function sameSchedule(a: Schedule, b: Schedule): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const av = a[k];
    const bv = b[k];
    return !!av && !!bv && av.start === bv.start && av.end === bv.end;
  });
}

/**
 * Weekly recurring shift template. Each day is either off or a single time
 * range, edited through the shared {@link WeeklyHoursGrid}. Edits are staged
 * locally and committed in a single PATCH to the staff row's `schedule` jsonb.
 */
export function StaffSchedule({ staff }: { staff: Staff }) {
  const update = useUpdateStaff(staff.id);
  const { can } = usePermissions();
  const [draft, setDraft] = useState<Schedule>(staff.schedule ?? {});

  // Re-sync when the upstream record changes (e.g. after a save invalidates).
  useEffect(() => {
    setDraft(staff.schedule ?? {});
  }, [staff.schedule]);

  const dirty = useMemo(() => !sameSchedule(draft, staff.schedule ?? {}), [draft, staff.schedule]);
  const invalid = useMemo(
    () => Object.values(draft).some((r) => r.start >= r.end),
    [draft],
  );

  const save = async () => {
    try {
      await update.mutateAsync({ schedule: draft });
      toast.success('Schedule saved');
    } catch (err) {
      toast.error('Could not save schedule', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  const workingCount = Object.keys(draft).length;

  return (
    <div className="panel staff-schedule">
      <div className="staff-schedule__head">
        <div className="staff-schedule__title">
          <CalendarClock size={16} strokeWidth={1.6} />
          <h3>Weekly shifts</h3>
          <span className="staff-schedule__count">
            {workingCount === 0 ? 'No days set' : `${workingCount} working ${workingCount === 1 ? 'day' : 'days'}`}
          </span>
        </div>
        <Can perm="staff:update">
          <button
            className="btn small primary"
            onClick={() => void save()}
            disabled={!dirty || invalid || update.isPending}
          >
            {update.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            Save schedule
          </button>
        </Can>
      </div>

      <WeeklyHoursGrid
        value={draft}
        onChange={setDraft}
        readOnly={!can('staff:update')}
        showClone
      />

      {dirty && <p className="staff-schedule__hint">Unsaved changes — click “Save schedule”.</p>}
    </div>
  );
}
