import { useEffect, useState } from 'react';
import type { Expense, PurchaseBillInput } from '@cafe-mgmt/api-types';
import { Modal } from '@/components/Modal';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { useCreatePurchaseBill, useCreatePurchaseReturn, usePurchaseBill } from '@/lib/api';
import { toast } from '@/lib/toast';

// The supplier-bill detail of an expense, for the IRD purchase register
// (procedure 2082 §6.3(क), Annex 6 §3). Once recorded it is permanent;
// goods sent back are a purchase return (PR-n), never an edit.

const toPaisa = (s: string) => parsePriceInput(s) ?? 0;

export function PurchaseBillModal({ expense, onClose }: { expense: Expense | null; onClose: () => void }) {
  const open = expense !== null;
  const bill = usePurchaseBill(expense?.id, open);
  const create = useCreatePurchaseBill();
  const createReturn = useCreatePurchaseReturn();
  const [f, setF] = useState({
    supplier_name: '',
    supplier_pan: '',
    supplier_bill_no: '',
    supplier_bill_date_bs: '',
    is_import: false,
    customs_declaration_no: '',
    is_capital: false,
    exempt: '',
    taxable: '',
    vat: '',
  });
  const [ret, setRet] = useState({ reason: '', note: '', exempt: '', taxable: '', vat: '' });
  const [err, setErr] = useState<string | null>(null);
  const [vatConfirm, setVatConfirm] = useState(false);

  useEffect(() => {
    if (!expense) return;
    const total = expense.amount_cents;
    const taxable = Math.round((total * 100) / 113);
    setF({
      supplier_name: expense.vendor ?? '',
      supplier_pan: '',
      supplier_bill_no: expense.reference_no ?? '',
      supplier_bill_date_bs: '',
      is_import: false,
      customs_declaration_no: '',
      is_capital: false,
      exempt: '0',
      taxable: String(taxable / 100),
      vat: String((total - taxable) / 100),
    });
    setRet({ reason: '', note: '', exempt: '', taxable: '', vat: '' });
    setErr(null);
    setVatConfirm(false);
  }, [expense]);

  if (!expense) return null;
  const sum = toPaisa(f.exempt) + toPaisa(f.taxable) + toPaisa(f.vat);

  const save = async () => {
    setErr(null);
    const body: PurchaseBillInput = {
      supplier_name: f.supplier_name,
      supplier_pan: f.supplier_pan,
      supplier_bill_no: f.supplier_bill_no,
      supplier_bill_date_bs: f.supplier_bill_date_bs,
      is_import: f.is_import,
      customs_declaration_no: f.customs_declaration_no,
      is_capital: f.is_capital,
      exempt_cents: toPaisa(f.exempt),
      taxable_cents: toPaisa(f.taxable),
      vat_cents: toPaisa(f.vat),
      confirm_vat_mismatch: vatConfirm,
    };
    try {
      await create.mutateAsync({ expenseId: expense.id, body });
      toast.success('Supplier bill recorded', 'It is now in the IRD purchase register');
    } catch (e: unknown) {
      const ae = e as { message?: string; code?: string };
      if (ae.code === 'vat_mismatch') setVatConfirm(false);
      setErr(ae.message ?? 'Failed');
    }
  };

  const saveReturn = async () => {
    if (!bill.data) return;
    setErr(null);
    try {
      const r = await createReturn.mutateAsync({
        billId: bill.data.id,
        expenseId: expense.id,
        body: {
          reason: ret.reason,
          supplier_note_no: ret.note,
          exempt_cents: toPaisa(ret.exempt),
          taxable_cents: toPaisa(ret.taxable),
          vat_cents: toPaisa(ret.vat),
        },
      });
      toast.success(`Purchase return ${r.number} recorded`);
      setRet({ reason: '', note: '', exempt: '', taxable: '', vat: '' });
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  const b = bill.data;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Supplier bill (IRD purchase register)"
      subtitle={`${expense.vendor || 'Expense'} · ${formatNPR(expense.amount_cents)}`}
    >
      {err && <div className="banner-error">{err}</div>}
      {bill.isPending ? (
        <div className="empty-state">Loading…</div>
      ) : b ? (
        <>
          <div className="purchase-bill-summary">
            <div>
              <strong>{b.supplier_name}</strong> {b.supplier_pan ? `· PAN ${b.supplier_pan}` : '· unregistered'}
            </div>
            <div className="muted">
              Bill {b.supplier_bill_no} · {b.supplier_bill_date_bs} BS · FY {b.fiscal_year}
              {b.is_import ? ` · import ${b.customs_declaration_no}` : ''}
              {b.is_capital ? ' · capital' : ''}
            </div>
            <div>
              Exempt {formatNPR(b.exempt_cents)} · Taxable {formatNPR(b.taxable_cents)} · VAT {formatNPR(b.vat_cents)}
              {b.returned_cents > 0 && <> · returned {formatNPR(b.returned_cents)}</>}
            </div>
          </div>
          <h4 style={{ marginTop: 16 }}>Record a purchase return</h4>
          <div className="purchase-grid">
            <div className="field">
              <label>Reason</label>
              <input value={ret.reason} onChange={(e) => setRet({ ...ret, reason: e.target.value })} maxLength={300} />
            </div>
            <div className="field">
              <label>Supplier’s note no.</label>
              <input value={ret.note} onChange={(e) => setRet({ ...ret, note: e.target.value })} maxLength={60} />
            </div>
            <div className="field">
              <label>Exempt</label>
              <input inputMode="decimal" value={ret.exempt} onChange={(e) => setRet({ ...ret, exempt: e.target.value })} />
            </div>
            <div className="field">
              <label>Taxable</label>
              <input inputMode="decimal" value={ret.taxable} onChange={(e) => setRet({ ...ret, taxable: e.target.value })} />
            </div>
            <div className="field">
              <label>VAT</label>
              <input inputMode="decimal" value={ret.vat} onChange={(e) => setRet({ ...ret, vat: e.target.value })} />
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn primary" disabled={createReturn.isPending} onClick={saveReturn}>
              Record return
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="purchase-grid">
            <div className="field">
              <label>Supplier name</label>
              <input value={f.supplier_name} onChange={(e) => setF({ ...f, supplier_name: e.target.value })} maxLength={200} />
            </div>
            <div className="field">
              <label>Supplier PAN / VAT no.</label>
              <input
                value={f.supplier_pan}
                onChange={(e) => setF({ ...f, supplier_pan: e.target.value })}
                inputMode="numeric"
                placeholder="blank if unregistered"
                maxLength={11}
              />
            </div>
            <div className="field">
              <label>Supplier bill no.</label>
              <input value={f.supplier_bill_no} onChange={(e) => setF({ ...f, supplier_bill_no: e.target.value })} maxLength={60} />
            </div>
            <div className="field">
              <label>Bill date (BS)</label>
              <input
                value={f.supplier_bill_date_bs}
                onChange={(e) => setF({ ...f, supplier_bill_date_bs: e.target.value })}
                placeholder="2083-07-21"
                maxLength={10}
              />
            </div>
            <div className="field">
              <label>Exempt amount</label>
              <input inputMode="decimal" value={f.exempt} onChange={(e) => setF({ ...f, exempt: e.target.value })} />
            </div>
            <div className="field">
              <label>Taxable amount</label>
              <input inputMode="decimal" value={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.value })} />
            </div>
            <div className="field">
              <label>VAT</label>
              <input inputMode="decimal" value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value })} />
            </div>
          </div>
          <div className="filter-row" style={{ margin: '8px 0' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={f.is_capital} onChange={(e) => setF({ ...f, is_capital: e.target.checked })} />
              Capital purchase (equipment)
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={f.is_import} onChange={(e) => setF({ ...f, is_import: e.target.checked })} />
              Import
            </label>
          </div>
          {f.is_import && (
            <div className="field">
              <label>Customs declaration (प्रज्ञापनपत्र) no.</label>
              <input
                value={f.customs_declaration_no}
                onChange={(e) => setF({ ...f, customs_declaration_no: e.target.value })}
                maxLength={60}
              />
            </div>
          )}
          <div className={sum === expense.amount_cents ? 'field-hint' : 'field-hint error'}>
            Exempt + taxable + VAT = {formatNPR(sum)}
            {sum !== expense.amount_cents && ` — must equal the expense, ${formatNPR(expense.amount_cents)}`}
          </div>
          {err?.includes('not 13%') && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" checked={vatConfirm} onChange={(e) => setVatConfirm(e.target.checked)} />
              The VAT is exactly as printed on the supplier’s bill
            </label>
          )}
          <div className="modal-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={create.isPending || sum !== expense.amount_cents}
              onClick={save}
            >
              {create.isPending ? 'Saving…' : 'Record supplier bill'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
