import { AlertTriangle } from 'lucide-react';
import type { BranchStatus } from '@cafe-mgmt/api-types';

const WHY: Record<BranchStatus['status'], string> = {
  ok: '',
  forbidden: "you can't see its reports",
  plan_upgrade_required: "its plan doesn't include this report",
  not_found: 'not found',
  error: "it didn't answer — try again",
};

/** "Showing 2 of 3 branches — Lakeside: you can't see its reports". Shown on
 *  every all-branches figure so a partial total never passes for the whole
 *  business. Renders nothing when every branch answered. */
export function CoverageNote({ statuses }: { statuses?: BranchStatus[] }) {
  const all = statuses ?? [];
  const missing = all.filter((s) => s.status !== 'ok');
  if (missing.length === 0) return null;
  return (
    <div className="bo-coverage" role="status">
      <AlertTriangle size={14} strokeWidth={1.6} aria-hidden />
      <span>
        Showing {all.length - missing.length} of {all.length} branches.{' '}
        {missing.map((m) => `${m.name || m.slug}: ${WHY[m.status]}`).join(' · ')}
      </span>
    </div>
  );
}
