import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Store, Printer, Star } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { AlphaSortToggle } from '@/components/AlphaSortToggle';
import { useAlphaSort } from '@/lib/useAlphaSort';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import {
  useOutlets,
  useCreateOutlet,
  useUpdateOutlet,
  useDeleteOutlet,
  useMe,
  hasFeature,
  type Outlet,
} from '@/lib/api';

// Prep destinations (Kitchen, Bar, Bar2…). Categories/items route to an outlet
// and each outlet has one network printer. A single-outlet cafe just sees
// "Kitchen"; adding a second outlet turns on the per-outlet KDS + docket routing.
export function OutletsPage() {
  const list = useOutlets();
  const create = useCreateOutlet();
  const update = useUpdateOutlet();
  const del = useDeleteOutlet();
  const confirm = useConfirm();
  const { can } = usePermissions();
  const me = useMe();
  // Printer setup is meaningless without the thermal-printing feature, so hide
  // every printer column/field for tenants that don't have it.
  const printingEnabled = hasFeature(me.data, 'thermal_printing');
  const [editing, setEditing] = useState<Partial<Outlet> | null>(null);

  const outlets = useMemo(() => list.data ?? [], [list.data]);
  const { sorted, alpha, toggle } = useAlphaSort(outlets, (o) => o.name, 'outlets');

  const makeDefault = (o: Outlet) => {
    update.mutate(
      { id: o.id, patch: { is_default: true } },
      {
        onSuccess: () => toast.success(`${o.name} is now the default outlet`),
        onError: (e) => toast.error('Could not set default', e.message),
      },
    );
  };

  return (
    <PageShell
      eyebrow="Prep routing"
      title="Outlets"
      actions={
        <>
          {outlets.length > 0 && <AlphaSortToggle active={alpha} onToggle={toggle} />}
          {can('outlet:create') && (
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                setEditing({ name: '', printer_port: 9100, printer_width: '80', is_active: true })
              }
            >
              <Plus size={14} strokeWidth={1.5} /> New outlet
            </button>
          )}
        </>
      }
    >
      <div className="panel">
        <p className="tab-sub" style={{ padding: '0 4px 12px' }}>
          An outlet is a prep station — Kitchen, Bar, Bar2… Menu categories (and
          individual items) route to an outlet, which has its own kitchen board
          and one network printer. Cook dockets print to the outlet's printer with
          its name on the header.
        </p>

        {list.isPending && <LoadingState />}
        {list.isError && !list.data && <ErrorState onRetry={() => list.refetch()} />}

        {list.data && list.data.length > 0 && (
          <table className="t tables-grid">
            <thead>
              <tr>
                <th style={{ width: 48 }}></th>
                <th>Name</th>
                {printingEnabled && <th>Printer</th>}
                {printingEnabled && <th style={{ width: 70 }}>Width</th>}
                <th>Status</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((o) => (
                <tr key={o.id}>
                  <td>
                    <div className="table-row-icon">
                      <Store size={22} strokeWidth={1.5} />
                    </div>
                  </td>
                  <td>
                    <strong>{o.name}</strong>{' '}
                    {o.is_default && (
                      <span className="pill" title="Routing fallback for items with no outlet set">
                        <Star size={11} strokeWidth={1.7} /> Default
                      </span>
                    )}
                  </td>
                  {printingEnabled && (
                    <td className="sku">
                      {o.printer_ip ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                          <Printer size={13} strokeWidth={1.6} /> {o.printer_ip}:{o.printer_port}
                        </span>
                      ) : (
                        <span className="muted">No printer</span>
                      )}
                    </td>
                  )}
                  {printingEnabled && <td className="sku">{o.printer_width}mm</td>}
                  <td>
                    <span className={`pill ${o.is_active ? 'ok' : 'bad'}`}>
                      {o.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      {can('outlet:update') && !o.is_default && (
                        <button
                          type="button"
                          className="btn icon"
                          onClick={() => makeDefault(o)}
                          aria-label="Make default"
                          title="Make default outlet"
                        >
                          <Star size={14} strokeWidth={1.5} />
                        </button>
                      )}
                      {can('outlet:update') && (
                        <button type="button" className="btn icon" onClick={() => setEditing(o)} aria-label="Edit">
                          <Pencil size={14} strokeWidth={1.5} />
                        </button>
                      )}
                      {can('outlet:delete') && !o.is_default && (
                        <button
                          type="button"
                          className="btn icon danger"
                          onClick={async () => {
                            const ok = await confirm({
                              title: 'Delete outlet?',
                              message: (
                                <>
                                  Remove <strong>{o.name}</strong>? Categories and
                                  items routed here fall back to the default outlet.
                                </>
                              ),
                              danger: true,
                            });
                            if (ok)
                              del.mutate(o.id, {
                                onError: (e) => toast.error('Could not delete', e.message),
                              });
                          }}
                          aria-label="Delete"
                        >
                          <Trash2 size={14} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <OutletModal
        editing={editing}
        printingEnabled={printingEnabled}
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

function OutletModal({
  editing,
  printingEnabled,
  onClose,
  onSubmit,
  pending,
}: {
  editing: Partial<Outlet> | null;
  printingEnabled: boolean;
  onClose: () => void;
  onSubmit: (v: Partial<Outlet>) => Promise<void>;
  pending: boolean;
}) {
  const open = editing !== null;
  const [name, setName] = useState('');
  const [printerIp, setPrinterIp] = useState('');
  const [printerPort, setPrinterPort] = useState('9100');
  const [printerWidth, setPrinterWidth] = useState<'58' | '80'>('80');
  const [active, setActive] = useState(true);

  const last = useRef<Partial<Outlet> | null>(null);
  useEffect(() => {
    if (editing !== last.current) {
      setName(editing?.name ?? '');
      setPrinterIp(editing?.printer_ip ?? '');
      setPrinterPort(String(editing?.printer_port ?? 9100));
      setPrinterWidth(editing?.printer_width ?? '80');
      setActive(editing?.is_active ?? true);
      last.current = editing;
    }
  }, [editing]);

  return (
    <Modal open={open} onClose={onClose} title={editing?.id ? 'Edit outlet' : 'New outlet'} subtitle="Prep station">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const portN = Math.min(65535, Math.max(1, parseInt(printerPort, 10) || 9100));
          void onSubmit({
            name,
            printer_ip: printerIp.trim() || null,
            printer_port: portN,
            printer_width: printerWidth,
            ...(editing?.id ? { is_active: active } : {}),
          });
        }}
      >
        <label>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Kitchen, Bar, Coffee counter…"
          required
          autoFocus
        />

        {printingEnabled && (
          <>
            <label>Printer IP</label>
            <input
              value={printerIp}
              onChange={(e) => setPrinterIp(e.target.value)}
              placeholder="192.168.1.50 (leave blank for none)"
            />
            <div className="field-hint">
              The network (ESC/POS) printer for this station. The mobile app prints
              straight to it. On web, browser printing goes to each device's default
              printer — set which outlets a device auto-prints under Settings → Printing.
            </div>

            <div className="row-inputs">
              <div>
                <label>Printer port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={printerPort}
                  onChange={(e) => setPrinterPort(e.target.value)}
                />
              </div>
              <div>
                <label>Paper width</label>
                <select value={printerWidth} onChange={(e) => setPrinterWidth(e.target.value as '58' | '80')}>
                  <option value="80">80mm</option>
                  <option value="58">58mm</option>
                </select>
              </div>
            </div>
          </>
        )}

        {editing?.id && (
          <>
            <label>Status</label>
            <select value={active ? 'on' : 'off'} onChange={(e) => setActive(e.target.value === 'on')}>
              <option value="on">Active</option>
              <option value="off">Inactive</option>
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
