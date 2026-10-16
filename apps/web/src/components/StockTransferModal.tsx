import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Plus, Send, Trash2 } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useCreateStockTransfer, useInventoryItems, useStockTransfers, type InventoryItem } from '@/lib/api';
import { branchColor, branchLabel } from '@/lib/branches';
import { normalizeQtyTyping, parseQtyInput } from '@/lib/numbers';
import { toast } from '@/lib/toast';
import { useOverview } from '@/lib/useBranchNav';

type Line = { itemId: string; qty: string };

const trimQty = (s: string) => s.replace(/\.?0+$/, '');

/**
 * Send stock from this branch to another — the central-kitchen run. Both
 * branches' stock changes in one go on the server, or neither does. The
 * receiving branch's item is matched by name; if it doesn't stock it yet, it
 * starts to, with this branch's unit and packs.
 */
export function StockTransferModal({
  open,
  onClose,
  initialItem,
}: {
  open: boolean;
  onClose: () => void;
  initialItem?: InventoryItem | null;
}) {
  const { business, branches } = useOverview();
  const items = useInventoryItems();
  const send = useCreateStockTransfer();
  const targets = branches.filter((b) => !b.is_active);

  const [to, setTo] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTo(targets.find((b) => b.can?.inventory_adjust)?.slug ?? '');
    setLines([{ itemId: initialItem?.id ?? '', qty: '' }]);
    setNote('');
    setErr(null);
    // Reset only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialItem?.id]);

  const byId = useMemo(() => new Map((items.data ?? []).map((i) => [i.id, i])), [items.data]);
  const target = targets.find((b) => b.slug === to);
  const label = (n: string) => branchLabel(n, business?.name);

  const problems = lines.map((l) => {
    if (!l.itemId) return 'Pick an item';
    const it = byId.get(l.itemId);
    const q = parseQtyInput(l.qty);
    if (q === null || Number(q) <= 0) return 'Enter how much to send';
    if (it && Number(q) > Number(it.qty_on_hand_units)) return `Only ${trimQty(it.qty_on_hand_units)} ${it.sale_unit} on hand`;
    return null;
  });
  const ready = !!target && lines.length > 0 && problems.every((p) => p === null);

  const submit = () => {
    setErr(null);
    send.mutate(
      {
        to,
        note: note.trim() || undefined,
        lines: lines.map((l) => ({ inventory_item_id: l.itemId, qty_units: parseQtyInput(l.qty) ?? '' })),
      },
      {
        onSuccess: (res) => {
          const created = res.lines.filter((l) => l.created_at_destination).map((l) => l.item);
          toast.success(
            `Sent ${res.lines.length} ${res.lines.length === 1 ? 'item' : 'items'} to ${label(res.to.name)}`,
            created.length ? `${label(res.to.name)} now stocks ${created.join(', ')}` : undefined,
          );
          onClose();
        },
        onError: (e) => setErr(e.message),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send stock to a branch"
      subtitle="Taken off this branch, added to theirs — together"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!ready || send.isPending} onClick={submit}>
            <Send size={14} strokeWidth={1.6} /> {send.isPending ? 'Sending…' : target ? `Send to ${label(target.name)}` : 'Send'}
          </button>
        </>
      }
    >
      {err && <div className="banner-error">{err}</div>}
      <div className="xfer">
        <div className="field">
          <label>To</label>
          <div className="sync-targets" role="radiogroup" aria-label="Branch to send to">
            {targets.map((b) => {
              const allowed = !!b.can?.inventory_adjust;
              return (
                <label key={b.slug} className={`sync-target${allowed ? '' : ' is-disabled'}${to === b.slug ? ' is-on' : ''}`}>
                  <input type="radio" name="xfer-to" checked={to === b.slug} disabled={!allowed} onChange={() => setTo(b.slug)} />
                  <span className="branch-dot" style={{ background: branchColor(branches, b.slug) }} aria-hidden />
                  <span className="sync-target__name">{label(b.name)}</span>
                  {!allowed && <span className="sync-target__why">no stock access</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Items</label>
          <div className="xfer-lines">
            {lines.map((l, i) => {
              const it = byId.get(l.itemId);
              const taken = new Set(lines.filter((_, j) => j !== i).map((x) => x.itemId));
              return (
                <div key={i} className="xfer-line">
                  <select
                    value={l.itemId}
                    aria-label={`Item ${i + 1}`}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}
                  >
                    <option value="">Choose an item…</option>
                    {(items.data ?? [])
                      .filter((x) => !taken.has(x.id))
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name} · {trimQty(x.qty_on_hand_units)} {x.sale_unit} on hand
                        </option>
                      ))}
                  </select>
                  <div className="xfer-qty">
                    <input
                      value={l.qty}
                      inputMode="decimal"
                      aria-label={`Quantity ${i + 1}`}
                      placeholder="0"
                      onChange={(e) =>
                        setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: normalizeQtyTyping(e.target.value) } : x)))
                      }
                    />
                    <span className="xfer-unit">{it?.sale_unit ?? ''}</span>
                  </div>
                  <button
                    type="button"
                    className="btn icon ghost"
                    aria-label={`Remove item ${i + 1}`}
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                  {problems[i] && l.itemId && l.qty && <span className="xfer-problem">{problems[i]}</span>}
                </div>
              );
            })}
          </div>
          <button type="button" className="btn ghost small" onClick={() => setLines((ls) => [...ls, { itemId: '', qty: '' }])}>
            <Plus size={13} strokeWidth={1.6} /> Add another item
          </button>
        </div>

        <div className="field">
          <label>Note</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional — e.g. weekend top-up" />
        </div>
      </div>
    </Modal>
  );
}

/** Recent transfers in and out of this branch. */
export function StockTransfersModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useStockTransfers(open);
  const rows = q.data?.transfers ?? [];
  return (
    <Modal open={open} onClose={onClose} title="Stock transfers" subtitle="Sent to and received from other branches">
      {q.isPending && <p className="field-hint">Loading…</p>}
      {!q.isPending && rows.length === 0 && <p className="field-hint">No transfers yet.</p>}
      <ul className="xfer-history">
        {rows.map((t) => (
          <li key={t.id}>
            <span className={`pill ${t.direction === 'in' ? 'ok' : 'warn'}`}>
              {t.direction === 'in' ? <ArrowDownLeft size={11} strokeWidth={1.8} /> : <ArrowUpRight size={11} strokeWidth={1.8} />}
              {t.direction === 'in' ? 'In' : 'Out'}
            </span>
            <div className="xfer-history__body">
              <span className="xfer-history__note">{t.note}</span>
              <span className="xfer-history__lines">
                {t.lines.map((l) => `${trimQty(l.qty_units)} ${l.sale_unit} ${l.item}`).join(' · ')}
              </span>
            </div>
            <span className="xfer-history__at">
              {new Date(t.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
