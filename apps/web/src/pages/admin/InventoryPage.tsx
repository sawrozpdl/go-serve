import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Sliders, Boxes, Trash2, History } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { PageShell } from '@/components/PageShell';
import { usePermissions } from '@/lib/permissions';
import {
  useInventoryItems,
  useCreateInventoryItem,
  useUpdateInventoryItem,
  useDeleteInventoryItem,
  useAdjustInventory,
  useInventoryMovements,
  useInventoryMovementsPaged,
  usePackRules,
  useCreatePackRule,
  useDeletePackRule,
  type InventoryItem,
  type StockMovement,
  type StockReason,
} from '@/lib/api';

/** More sold than ever recorded in stock — the ledger went below zero. */
function isNegative(it: InventoryItem): boolean {
  return parseFloat(it.qty_on_hand_units) < 0;
}

export function InventoryPage() {
  const { can, canAny } = usePermissions();
  const list = useInventoryItems();
  const del = useDeleteInventoryItem();
  const confirm = useConfirm();

  const [editing, setEditing] = useState<Partial<InventoryItem> | null>(null);
  const [adjusting, setAdjusting] = useState<InventoryItem | null>(null);
  const [packing, setPacking] = useState<InventoryItem | null>(null);
  const [history, setHistory] = useState<InventoryItem | null>(null);

  const lowCount = (list.data ?? []).filter((i) => i.is_low_stock && !isNegative(i)).length;
  const negCount = (list.data ?? []).filter(isNegative).length;

  return (
    <PageShell
      eyebrow="Stock"
      title="Inventory"
      actions={
        <>
          {negCount > 0 && (
            <span className="pill bad" title="Stock ledgers below zero — record purchases or adjustments">
              {negCount} Negative
            </span>
          )}
          {lowCount > 0 && <span className="pill warn">{lowCount} Low</span>}
          {can('inventory:create') && (
            <button
              type="button"
              className="btn primary"
              onClick={() => setEditing({ name: '', kind: 'retail', sale_unit: 'unit', par_low_units: '0' })}
            >
              <Plus size={14} strokeWidth={1.5} /> New item
            </button>
          )}
        </>
      }
    >
      <div className="panel">
        {list.isPending && <LoadingState />}
        {list.isError && !list.data && <ErrorState onRetry={() => list.refetch()} />}
        {list.data?.length === 0 && (
          <div className="empty-state">
            No inventory items yet.
            <br />
            Add cigarettes, water, hookah charcoal, etc.
          </div>
        )}
        {list.data && list.data.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>SKU</th>
                <th>Unit</th>
                <th style={{ textAlign: 'right' }}>On hand</th>
                <th style={{ textAlign: 'right' }}>Par low</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 200 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((it) => (
                <tr key={it.id}>
                  <td>
                    <strong>{it.name}</strong>
                    <div style={{ fontSize: 11, color: 'var(--ink-400)' }}>{it.kind}</div>
                  </td>
                  <td className="sku">{it.sku ?? '—'}</td>
                  <td className="sku">{it.sale_unit}</td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      color: isNegative(it) ? 'var(--danger-fg)' : undefined,
                    }}
                  >
                    {trim(it.qty_on_hand_units)}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ink-400)' }}>
                    {trim(it.par_low_units)}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {it.last_purchase_unit_cost_cents != null ? formatNPR(it.last_purchase_unit_cost_cents) : '—'}
                  </td>
                  <td>
                    {isNegative(it) ? (
                      <span
                        className="pill bad"
                        title="More sold than recorded in stock — record a purchase or adjustment"
                      >
                        negative
                      </span>
                    ) : (
                      <span className={`pill ${it.is_low_stock ? 'warn' : 'ok'}`}>
                        {it.is_low_stock ? 'low' : 'ok'}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      {can('inventory:adjust') && (
                        <button type="button" className="btn icon" onClick={() => setAdjusting(it)} title="Adjust stock">
                          <Sliders size={14} strokeWidth={1.5} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn icon"
                        onClick={() => setHistory(it)}
                        title="Movement history"
                      >
                        <History size={14} strokeWidth={1.5} />
                      </button>
                      {canAny('inventory:create', 'inventory:delete') && (
                        <button type="button" className="btn icon" onClick={() => setPacking(it)} title="Pack rules">
                          <Boxes size={14} strokeWidth={1.5} />
                        </button>
                      )}
                      {can('inventory:update') && (
                        <button type="button" className="btn icon" onClick={() => setEditing(it)} aria-label="edit">
                          <Pencil size={14} strokeWidth={1.5} />
                        </button>
                      )}
                      {can('inventory:delete') && (
                        <button
                          type="button"
                          className="btn icon danger"
                          onClick={async () => {
                            const ok = await confirm({
                              title: 'Delete inventory item?',
                              message: (
                                <>
                                  Remove <strong>{it.name}</strong>? Past stock
                                  movements stay on file but the item disappears
                                  from menus and expense linkage.
                                </>
                              ),
                              danger: true,
                            });
                            if (ok) del.mutate(it.id);
                          }}
                          aria-label="delete"
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

      <ItemModal editing={editing} onClose={() => setEditing(null)} />
      <AdjustModal
        item={adjusting}
        onClose={() => setAdjusting(null)}
        onViewHistory={(it) => {
          setAdjusting(null);
          setHistory(it);
        }}
      />
      <PackModal item={packing} onClose={() => setPacking(null)} />
      <MovementsModal item={history} onClose={() => setHistory(null)} />
    </PageShell>
  );
}

// -------------------------------------------------------------------------
// Inventory item modal
// -------------------------------------------------------------------------

function ItemModal({ editing, onClose }: { editing: Partial<InventoryItem> | null; onClose: () => void }) {
  const create = useCreateInventoryItem();
  const update = useUpdateInventoryItem();
  const open = editing !== null;
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [kind, setKind] = useState<'retail' | 'ingredient'>('retail');
  const [unit, setUnit] = useState('');
  const [parLow, setParLow] = useState('');
  const [notes, setNotes] = useState('');

  const last = useRef<Partial<InventoryItem> | null>(null);
  useEffect(() => {
    if (editing !== last.current) {
      setName(editing?.name ?? '');
      setSku(editing?.sku ?? '');
      setKind(editing?.kind ?? 'retail');
      setUnit(editing?.sale_unit ?? 'unit');
      setParLow(editing?.par_low_units ?? '0');
      setNotes(editing?.notes ?? '');
      last.current = editing;
    }
  }, [editing]);

  return (
    <Modal open={open} onClose={onClose} title={editing?.id ? 'Edit Item' : 'New Inventory Item'} subtitle="Stock master">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const patch = {
            name,
            sku: sku || null,
            kind,
            sale_unit: unit || 'unit',
            par_low_units: parLow || '0',
            notes,
          };
          if (editing?.id) {
            await update.mutateAsync({ id: editing.id, patch });
          } else {
            await create.mutateAsync(patch);
          }
          onClose();
        }}
      >
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

        <div className="row-inputs">
          <div>
            <label>SKU</label>
            <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="optional" />
            <div className="field-hint">
              stock keeping unit — short identifier (e.g. CIG-MAR, FLOUR-50). use to
              cross-reference suppliers / barcodes.
            </div>
          </div>
          <div>
            <label>Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'retail' | 'ingredient')}>
              <option value="retail">retail (sold directly)</option>
              <option value="ingredient">ingredient (recipe input)</option>
            </select>
          </div>
        </div>

        <div className="row-inputs">
          <div>
            <label>Sale unit</label>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="stick, ml, g, unit" />
          </div>
          <div>
            <label>Par-low (alert when ≤)</label>
            <input value={parLow} onChange={(e) => setParLow(e.target.value)} placeholder="0" />
          </div>
        </div>

        <label>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={create.isPending || update.isPending}>
            {editing?.id ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------
// Adjust modal (record a stock_movement)
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Movement history modal — the item's full stock ledger, 50 rows a page.
// -------------------------------------------------------------------------

const REASON_PILL: Record<string, string> = {
  purchase: 'pill ok',
  sale: 'pill',
  waste: 'pill bad',
  adjust: 'pill warn',
  transfer: 'pill warn',
};

function MovementsModal({ item, onClose }: { item: InventoryItem | null; onClose: () => void }) {
  const paged = useInventoryMovementsPaged(item?.id);

  if (!item) return null;

  const rows: StockMovement[] = (paged.data?.pages ?? []).flatMap((p) => p.movements);
  const total = paged.data?.pages[0]?.total ?? 0;

  // Running balance, walked down from the live on-hand figure: rows arrive
  // newest-first and pages are contiguous, so the balance after row i equals
  // on-hand minus every delta above it.
  let running = parseFloat(item.qty_on_hand_units);
  const withBalance = rows.map((m) => {
    const balance = running;
    running -= parseFloat(m.delta_units) || 0;
    return { m, balance };
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Movement History"
      subtitle={`${item.name} · On hand: ${trim(item.qty_on_hand_units)} ${item.sale_unit} · ${total} movement${total === 1 ? '' : 's'}`}
    >
      {paged.isPending && <LoadingState compact />}
      {paged.isError && rows.length === 0 && <ErrorState compact onRetry={() => paged.refetch()} />}
      {!paged.isPending && rows.length === 0 && (
        <div className="empty-state">No movements yet — purchases, sales, and adjustments land here.</div>
      )}
      {rows.length > 0 && (
        <table className="t">
          <thead>
            <tr>
              <th>Reason</th>
              <th style={{ textAlign: 'right' }}>Delta</th>
              <th style={{ textAlign: 'right' }}>Balance</th>
              <th>By</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {withBalance.map(({ m, balance }) => (
              <tr key={m.id}>
                <td>
                  <span className={REASON_PILL[m.reason] ?? 'pill'}>{m.reason}</span>
                  {(m.notes || m.ref_type) && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-400)', marginTop: 2 }}>
                      {m.notes || m.ref_type}
                    </div>
                  )}
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    color: m.delta_units.startsWith('-') ? 'var(--amber-fg)' : 'var(--lime-fg)',
                  }}
                >
                  {trim(m.delta_units)}
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    color: balance < 0 ? 'var(--danger-fg)' : undefined,
                  }}
                >
                  {Math.round(balance * 1000) / 1000}
                </td>
                <td className="sku">{m.by_user_name ?? '—'}</td>
                <td className="sku">
                  {new Date(m.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="modal-actions" style={{ marginTop: 14 }}>
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
        {paged.hasNextPage && (
          <button
            type="button"
            className="btn"
            disabled={paged.isFetchingNextPage}
            onClick={() => paged.fetchNextPage()}
          >
            {paged.isFetchingNextPage ? 'Loading…' : `Load more (${rows.length}/${total})`}
          </button>
        )}
      </div>
    </Modal>
  );
}

function AdjustModal({
  item,
  onClose,
  onViewHistory,
}: {
  item: InventoryItem | null;
  onClose: () => void;
  onViewHistory: (item: InventoryItem) => void;
}) {
  const adjust = useAdjustInventory();
  const movements = useInventoryMovements(item?.id);
  const [reason, setReason] = useState<StockReason>('purchase');
  const [delta, setDelta] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const last = useRef<InventoryItem | null>(null);
  useEffect(() => {
    if (item !== last.current) {
      setReason('purchase');
      setDelta('');
      setUnitCost('');
      setNotes('');
      setErr(null);
      last.current = item;
    }
  }, [item]);

  if (!item) return null;

  return (
    <Modal open onClose={onClose} title="Adjust Stock" subtitle={`${item.name} · On hand: ${trim(item.qty_on_hand_units)} ${item.sale_unit}`}>
      {err && <div className="banner-error">{err}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const ucents = unitCost ? parsePriceInput(unitCost) ?? undefined : undefined;
          try {
            await adjust.mutateAsync({
              id: item.id,
              delta_units: delta,
              reason,
              notes,
              unit_cost_cents: ucents,
            });
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Reason</label>
        <select value={reason} onChange={(e) => setReason(e.target.value as StockReason)}>
          <option value="purchase">purchase (+)</option>
          <option value="adjust">adjust (manual count)</option>
          <option value="waste">waste (−)</option>
          <option value="transfer">transfer</option>
        </select>

        <div className="row-inputs">
          <div>
            <label>Delta ({item.sale_unit})</label>
            <input
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder={reason === 'waste' ? '-3' : '+200'}
              required
            />
          </div>
          {reason === 'purchase' && (
            <div>
              <label>Unit cost (NPR)</label>
              <input value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="1.50" />
            </div>
          )}
        </div>

        <label>Notes (audit trail)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={adjust.isPending}>
            {adjust.isPending ? 'Saving…' : 'Record'}
          </button>
        </div>
      </form>

      {movements.data && movements.data.length > 0 && (
        <div className="settle-payments">
          <div className="settle-payments-head">recent movements</div>
          {movements.data.slice(0, 6).map((m) => (
            <div key={m.id} className="settle-payments-row" style={{ gridTemplateColumns: 'auto 1fr auto auto' }}>
              <span className="pill">{m.reason}</span>
              <span className="ref">{m.notes || (m.ref_type ? m.ref_type : '')}</span>
              <span className="ref">{new Date(m.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
              <span className="amt" style={{ color: m.delta_units.startsWith('-') ? 'var(--amber-fg)' : 'var(--lime-fg)' }}>
                {m.delta_units}
              </span>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            style={{ marginTop: 'var(--space-2)' }}
            onClick={() => onViewHistory(item)}
          >
            <History size={12} strokeWidth={1.5} /> View full history
          </button>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------------------
// Pack rules drawer (modal)
// -------------------------------------------------------------------------

function PackModal({ item, onClose }: { item: InventoryItem | null; onClose: () => void }) {
  const { can } = usePermissions();
  const list = usePackRules(item?.id);
  const create = useCreatePackRule();
  const del = useDeletePackRule();
  const [containerUnit, setContainerUnit] = useState('');
  const [containerQty, setContainerQty] = useState('1');
  const [salePerContainer, setSalePerContainer] = useState('');

  if (!item) return null;

  return (
    <Modal open onClose={onClose} title="Pack Rules" subtitle={`${item.name} · Sale unit: ${item.sale_unit}`}>
      <div className="settle-payments" style={{ borderTop: 0, paddingTop: 0, marginTop: 0 }}>
        {list.isPending && <LoadingState compact />}
        {list.isError && !list.data && <ErrorState compact onRetry={() => list.refetch()} />}
        {list.data?.length === 0 && <div className="empty-state">No pack rules.</div>}
        {list.data?.map((p) => (
          <div key={p.id} className="settle-payments-row" style={{ gridTemplateColumns: '1fr auto auto' }}>
            <span>
              {p.container_qty} {p.container_unit} = {p.sale_qty_per_container} {p.sale_unit}
            </span>
            <span className="ref">{new Date(p.created_at).toLocaleDateString('en-GB')}</span>
            {can('inventory:delete') && (
              <button
                type="button"
                className="btn icon danger"
                onClick={() => del.mutate({ itemId: item.id, ruleId: p.id })}
                aria-label="delete"
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>
        ))}
      </div>

      {can('inventory:create') ? (
        <form
          style={{ borderTop: '1px solid var(--ink-800)', paddingTop: 14, marginTop: 14 }}
          onSubmit={async (e) => {
            e.preventDefault();
            await create.mutateAsync({
              id: item.id,
              container_unit: containerUnit,
              container_qty: Number(containerQty) || 1,
              sale_unit: item.sale_unit,
              sale_qty_per_container: Number(salePerContainer) || 1,
            });
            setContainerUnit('');
            setContainerQty('1');
            setSalePerContainer('');
          }}
        >
          <label>Add a rule</label>
          <div className="row-inputs">
            <div>
              <label>Container unit</label>
              <input value={containerUnit} onChange={(e) => setContainerUnit(e.target.value)} placeholder="carton" required />
            </div>
            <div>
              <label>Container qty</label>
              <input value={containerQty} onChange={(e) => setContainerQty(e.target.value)} type="number" min={1} />
            </div>
          </div>
          <label>{item.sale_unit}s per container</label>
          <input value={salePerContainer} onChange={(e) => setSalePerContainer(e.target.value)} type="number" min={1} placeholder="200" required />

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
            <button type="submit" className="btn primary" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add rule'}
            </button>
          </div>
        </form>
      ) : (
        <div className="modal-actions" style={{ borderTop: '1px solid var(--ink-800)', paddingTop: 14, marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}

// trim trailing ".000" so "200.000" → "200" but "12.500" stays.
function trim(num: string): string {
  if (!num.includes('.')) return num;
  return num.replace(/\.?0+$/, '');
}
