import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Armchair } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { IconPicker, IconGlyph } from '@/components/IconPicker';
import { PageShell } from '@/components/PageShell';
import {
  useServiceTables,
  useCreateServiceTable,
  useUpdateServiceTable,
  useDeleteServiceTable,
  type ServiceTable,
} from '@/lib/api';

const STATUS_PILL: Record<ServiceTable['status'], 'ok' | 'warn' | 'bad' | ''> = {
  free: 'ok',
  occupied: 'warn',
  reserved: '',
  dirty: 'bad',
};

const STATUS_LABEL: Record<ServiceTable['status'], string> = {
  free: 'Free',
  occupied: 'Occupied',
  reserved: 'Reserved',
  dirty: 'Dirty',
};

export function TablesPage() {
  const list = useServiceTables();
  const create = useCreateServiceTable();
  const update = useUpdateServiceTable();
  const del = useDeleteServiceTable();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<ServiceTable> | null>(null);

  return (
    <PageShell
      eyebrow="Floor plan"
      title="Tables"
      actions={
        <button
          type="button"
          className="btn primary"
          onClick={() => setEditing({ name: '', capacity: 2, area: '', icon: 'Armchair', sort: (list.data?.length ?? 0) + 1 })}
        >
          <Plus size={14} strokeWidth={1.5} /> New table
        </button>
      }
    >
      <div className="panel">
        {list.isPending && <div className="empty-state">Loading…</div>}
        {list.data?.length === 0 && (
          <div className="empty-state">
            No tables yet.
            <br />
            Add the cafe's floor plan to start taking orders.
          </div>
        )}

        {list.data && list.data.length > 0 && (
          <table className="t tables-grid">
            <thead>
              <tr>
                <th style={{ width: 64 }}></th>
                <th>Name</th>
                <th>Area</th>
                <th>Capacity</th>
                <th>Status</th>
                <th style={{ width: 70 }}>Sort</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="table-row-icon">
                      <IconGlyph name={t.icon} size={22} fallback={<Armchair size={22} strokeWidth={1.5} />} />
                    </div>
                  </td>
                  <td>
                    <strong>{t.name}</strong>
                  </td>
                  <td>{t.area || '—'}</td>
                  <td className="sku">{t.capacity}</td>
                  <td>
                    <span className={`pill ${STATUS_PILL[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                  </td>
                  <td className="sku">{t.sort}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn icon" onClick={() => setEditing(t)} aria-label="Edit">
                        <Pencil size={14} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        className="btn icon danger"
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Delete table?',
                            message: (
                              <>
                                Remove table <strong>{t.name}</strong> from
                                the floor plan?
                                {t.status === 'occupied' ? (
                                  <>
                                    {' '}
                                    Note: this table currently has an open tab.
                                  </>
                                ) : null}
                              </>
                            ),
                            danger: true,
                          });
                          if (ok) del.mutate(t.id);
                        }}
                        aria-label="Delete"
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <TableModal
        editing={editing}
        onClose={() => setEditing(null)}
        onSubmit={async (values) => {
          if (editing?.id) {
            await update.mutateAsync({ id: editing.id, patch: values });
          } else {
            await create.mutateAsync(values);
          }
          setEditing(null);
        }}
        pending={create.isPending || update.isPending}
      />
    </PageShell>
  );
}

function TableModal({
  editing,
  onClose,
  onSubmit,
  pending,
}: {
  editing: Partial<ServiceTable> | null;
  onClose: () => void;
  onSubmit: (v: Partial<ServiceTable>) => Promise<void>;
  pending: boolean;
}) {
  const open = editing !== null;
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('2');
  const [area, setArea] = useState('');
  const [icon, setIcon] = useState('Armchair');
  const [sort, setSort] = useState('0');
  const [status, setStatus] = useState<ServiceTable['status']>('free');

  const last = useRef<Partial<ServiceTable> | null>(null);
  useEffect(() => {
    if (editing !== last.current) {
      setName(editing?.name ?? '');
      setCapacity(String(editing?.capacity ?? 2));
      setArea(editing?.area ?? '');
      setIcon(editing?.icon ?? 'Armchair');
      setSort(String(editing?.sort ?? 0));
      setStatus(editing?.status ?? 'free');
      last.current = editing;
    }
  }, [editing]);

  return (
    <Modal open={open} onClose={onClose} title={editing?.id ? 'Edit table' : 'New table'} subtitle="Floor plan">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const capN = Math.max(1, parseInt(capacity, 10) || 1);
          const sortN = parseInt(sort, 10) || 0;
          void onSubmit({
            name,
            capacity: capN,
            area,
            icon,
            sort: sortN,
            ...(editing?.id ? { status } : {}),
          });
        }}
      >
        <label>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Table 1, Window, Counter…"
          required
          autoFocus
        />

        <label>Icon</label>
        <IconPicker value={icon} onChange={setIcon} compact />

        <div className="row-inputs">
          <div>
            <label>Capacity</label>
            <input
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </div>
          <div>
            <label>Sort</label>
            <input type="number" value={sort} onChange={(e) => setSort(e.target.value)} />
          </div>
        </div>

        <label>Area</label>
        <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Terrace, Indoor, Lounge…" />

        {editing?.id && (
          <>
            <label>Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ServiceTable['status'])}
            >
              <option value="free">Free</option>
              <option value="occupied">Occupied</option>
              <option value="reserved">Reserved</option>
              <option value="dirty">Dirty</option>
            </select>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? 'Saving…' : editing?.id ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
