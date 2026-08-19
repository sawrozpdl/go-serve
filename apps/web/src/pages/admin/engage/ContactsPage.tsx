import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { SearchInput } from '@/components/SearchInput';
import { useConfirm } from '@/components/ConfirmDialog';
import { getAccessToken } from '@/lib/auth-store';
import { triggerDownload } from '@/lib/downloads';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { useTenant } from '@/lib/tenant';
import { useDeleteAllEngageContacts, useDeleteEngageContact, useEngageContacts } from '@/lib/engage';

// =========================================================================
// Contacts tab — the only personal data in the module.
//
// There is deliberately NO "message everyone" button. v1 collects with
// consent, exports, and deletes; anything that blasts a list is a different
// feature with different obligations, and building the button first is how
// people end up with the obligations and no plan.
// =========================================================================

// Matches lib/api.ts — VITE_API_URL is the dev proxy target, not the origin
// baked into the bundle.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ContactsPage() {
  const { can } = usePermissions();
  const confirm = useConfirm();
  const { slug } = useTenant();
  const [q, setQ] = useState('');
  const contacts = useEngageContacts(q);
  const del = useDeleteEngageContact();
  const delAll = useDeleteAllEngageContacts();
  const mayDelete = can('engage:contacts_delete');

  // The CSV is generated server-side (the whole list, authoritative consent
  // columns), so this is a raw authed fetch rather than the JSON client.
  const exportCsv = async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/engage/contacts.csv`, {
        headers: {
          Authorization: `Bearer ${getAccessToken() ?? ''}`,
          'X-Tenant-ID': slug ?? '',
        },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `guest-contacts-${slug}-${new Date().toISOString().slice(0, 10)}.csv`);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Could not export', (e as Error).message);
    }
  };

  return (
    <PageShell
      eyebrow="grow"
      title="Engage"
      docTitle="Engage · Contacts"
      actions={
        <button type="button" className="btn" onClick={() => void exportCsv()}>
          <Download size={14} strokeWidth={1.5} /> Export CSV
        </button>
      }
    >
      <div className="panel">
        <p className="engage-hint">
          Guests who ticked the consent box after winning. You may only contact these people about offers,
          and an exported file contains personal data — treat it accordingly.
        </p>
        <SearchInput value={q} onChange={setQ} placeholder="Search name, phone or email" />
      </div>

      <QueryState
        isPending={contacts.isPending}
        isError={contacts.isError}
        error={contacts.error}
        refetch={contacts.refetch}
      >
        {(contacts.data?.contacts ?? []).length === 0 ? (
            <EmptyState
              title="No contacts yet"
              hint="Guests are asked after they win, and it's entirely optional — most won't, and the reward works either way."
            />
        ) : (
          <>
              <table className="t">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    <th>Consented</th>
                    <th className="right">Plays</th>
                    <th>Last seen</th>
                    {mayDelete && <th />}
                  </tr>
                </thead>
                <tbody>
                  {(contacts.data?.contacts ?? []).map((c) => (
                    <tr key={c.id}>
                      <td>{c.name || <span className="meta">—</span>}</td>
                      <td>{c.email || c.phone}</td>
                      <td>
                        <span className="pill ok">Opted in</span>{' '}
                        <span className="meta">{fmtDate(c.consent_at)}</span>
                      </td>
                      <td className="right num">{c.times_seen}</td>
                      <td>{fmtDate(c.last_seen_at)}</td>
                      {mayDelete && (
                        <td className="right">
                          <button
                            type="button"
                            className="btn icon danger"
                            aria-label={`delete contact`}
                            onClick={async () => {
                              const ok = await confirm({
                                title: 'Delete this contact?',
                                message: 'Use this when a guest asks to be removed. It cannot be undone.',
                                confirmLabel: 'Delete',
                                danger: true,
                              });
                              if (!ok) return;
                              await del.mutateAsync(c.id);
                              toast.success('Contact deleted');
                            }}
                          >
                            <Trash2 size={13} strokeWidth={1.6} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>

              {mayDelete && (
                <section className="panel danger-zone">
                  <div className="panel-head">
                    <h3>Delete everything</h3>
                  </div>
                  <p className="engage-hint">
                    Removes every guest contact for this café. There is no undo, and no export is taken first.
                  </p>
                  <button
                    type="button"
                    className="btn danger solid"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete all ${(contacts.data?.contacts ?? []).length} contacts?`,
                        message: 'Every opted-in guest contact for this café will be permanently removed.',
                        confirmLabel: 'Delete all',
                        danger: true,
                      });
                      if (!ok) return;
                      const res = await delAll.mutateAsync();
                      toast.success(`${res.deleted} contact(s) deleted`);
                    }}
                  >
                    Delete all contacts
                  </button>
                </section>
              )}
          </>
        )}
      </QueryState>
    </PageShell>
  );
}
