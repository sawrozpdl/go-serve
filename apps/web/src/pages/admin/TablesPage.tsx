import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
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

export function TablesPage() {
  const list = useServiceTables();
  const create = useCreateServiceTable();
  const update = useUpdateServiceTable();
  const del = useDeleteServiceTable();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<ServiceTable> | null>(null);

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">floor plan</span>
          <h1>Tables</h1>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => setEditing({ name: '', capacity: 2, area: '', sort: (list.data?.length ?? 0) + 1 })}
          >
            <Plus size={14} strokeWidth={1.5} /> New table
          </button>
        </div>
      </div>

      <div className="panel">
        {list.isPending && <div className="empty-state">loading…</div>}
        {list.data?.length === 0 && (
          <div className="empty-state">
            no tables yet.
            <br />
            add the cafe's floor plan to start taking orders.
          </div>
        )}

        {list.data && list.data.length > 0 && (
          <table className="t">
            <thead>
              <tr>
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
                    <strong>{t.name}</strong>
                  </td>
                  <td>{t.area || '—'}</td>
                  <td className="sku">{t.capacity}</td>
                  <td>
                    <span className={`pill ${STATUS_PILL[t.status]}`}>{t.status}</span>
                  </td>
                  <td className="sku">{t.sort}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn icon" onClick={() => setEditing(t)} aria-label="edit">
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
                        aria-label="delete"
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
    </>
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
  const [sort, setSort] = useState('0');
  const [status, setStatus] = useState<ServiceTable['status']>('free');

  const last = useRef<Partial<ServiceTable> | null>(null);
  useEffect(() => {
    if (editing !== last.current) {
      setName(editing?.name ?? '');
      setCapacity(String(editing?.capacity ?? 2));
      setArea(editing?.area ?? '');
      setSort(String(editing?.sort ?? 0));
      setStatus(editing?.status ?? 'free');
      last.current = editing;
    }
  }, [editing]);

  return (
    <Modal open={open} onClose={onClose} title={editing?.id ? 'edit table' : 'new table'} subtitle="floor plan">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const capN = Math.max(1, parseInt(capacity, 10) || 1);
          const sortN = parseInt(sort, 10) || 0;
          void onSubmit({
            name,
            capacity: capN,
            area,
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
              <option value="free">free</option>
              <option value="occupied">occupied</option>
              <option value="reserved">reserved</option>
              <option value="dirty">dirty</option>
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
