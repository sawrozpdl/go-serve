import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useAdminAudit, useAdminAuditFacets, type PlatformAuditFilters } from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { SearchInput } from '@/components/SearchInput';
import { RefreshButton } from '@/components/RefreshButton';

function fmtDate(s: string) {
  return new Date(s).toLocaleString();
}

/** Group actions by their prefix ("tenant.", "finance.", …) so the dropdown
 *  offers both "every tenant action" and the individual ones. */
function actionGroups(actions: string[]): { prefix: string; actions: string[] }[] {
  const byPrefix = new Map<string, string[]>();
  for (const a of actions) {
    const prefix = a.includes('.') ? a.slice(0, a.indexOf('.') + 1) : '';
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(a);
  }
  return [...byPrefix.entries()]
    .map(([prefix, list]) => ({ prefix, actions: list }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export function SuperAuditPage() {
  const [filters, setFilters] = useState<PlatformAuditFilters>({});
  const q = useAdminAudit(filters);
  const facets = useAdminAuditFacets();

  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  const filtered = Object.values(filters).some(Boolean);

  const set = (patch: Partial<PlatformAuditFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <PageShell
      eyebrow="Activity"
      title="Platform audit"
      subtitle="Every cross-tenant action taken from this console"
      docTitle="Platform audit"
      actions={<RefreshButton onClick={() => q.refetch()} busy={q.isFetching} />}
    >
      <div className="filter-row">
        <SearchInput
          value={filters.q ?? ''}
          onChange={(v) => set({ q: v || undefined })}
          placeholder="Search summaries and actors…"
        />
        <select
          value={filters.actor ?? ''}
          onChange={(e) => set({ actor: e.target.value || undefined })}
          aria-label="Filter by actor"
        >
          <option value="">Anyone</option>
          {(facets.data?.actors ?? []).map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filters.action ?? ''}
          onChange={(e) => set({ action: e.target.value || undefined })}
          aria-label="Filter by action"
        >
          <option value="">Any action</option>
          {actionGroups(facets.data?.actions ?? []).map(({ prefix, actions }) => (
            <optgroup key={prefix || 'other'} label={prefix || 'other'}>
              {/* The prefix option is a genuine filter of its own — the server
                  matches it as a prefix, so this means "all of these". */}
              {prefix && <option value={prefix}>everything in {prefix}…</option>}
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </optgroup>
          ))}
        </select>
        {filtered && (
          <button type="button" className="linklike" onClick={() => setFilters({})}>
            Clear filters
          </button>
        )}
      </div>

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={events.length === 0}
        errorTitle="Could not load the audit log"
        emptyTitle={filtered ? 'Nothing matches those filters' : 'No activity yet'}
        emptyHint={
          filtered
            ? 'Try widening the search, or clear the filters above.'
            : 'Console actions — provisioning, plan changes, payments, purges — are recorded here.'
        }
      >
        <div className="table-scroll">
          <table className="t">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Café</th><th>Summary</th></tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.created_at}-${i}`}>
                  <td className="muted">{fmtDate(e.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="linklike"
                      title="Filter to this person"
                      onClick={() => set({ actor: e.actor_email })}
                    >
                      {e.actor_email}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="pill linklike"
                      title="Filter to this action"
                      onClick={() => set({ action: e.action })}
                    >
                      {e.action}
                    </button>
                  </td>
                  <td>
                    {e.tenant_id
                      ? <Link to={`/super/tenants/${e.tenant_id}`}>{e.tenant_slug}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  <td>{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {q.hasNextPage && (
          <div className="audit-more">
            <button className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
        {!q.hasNextPage && events.length > 0 && (
          <p className="hint audit-more">That’s everything{filtered ? ' matching these filters' : ''}.</p>
        )}
      </QueryState>
    </PageShell>
  );
}
