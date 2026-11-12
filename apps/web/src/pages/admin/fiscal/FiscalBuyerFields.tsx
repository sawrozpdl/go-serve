import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { normalizePAN, type FiscalBuyer } from '@cafe-mgmt/api-types';

// Optional buyer block on the IRD invoice. A walk-in guest leaves it closed;
// a business guest gives its PAN to claim input VAT. Collapsed by default so
// the common settle stays one tap.
export function FiscalBuyerFields({
  value,
  onChange,
}: {
  value: FiscalBuyer;
  onChange: (b: FiscalBuyer) => void;
}) {
  const [open, setOpen] = useState(!!(value.name || value.pan));
  const panBad = !!value.pan && !normalizePAN(value.pan);
  return (
    <div className="fiscal-buyer">
      <button type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} strokeWidth={1.6} /> : <ChevronRight size={13} strokeWidth={1.6} />}
        Buyer on the invoice {value.pan ? `· PAN ${value.pan}` : '(optional)'}
      </button>
      {open && (
        <div className="fiscal-buyer-grid">
          <div className="field">
            <label>Buyer name</label>
            <input
              value={value.name ?? ''}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              maxLength={200}
              placeholder="e.g. Acme Traders Pvt. Ltd."
            />
          </div>
          <div className="field">
            <label>Buyer PAN / VAT no.</label>
            <input
              value={value.pan ?? ''}
              onChange={(e) => onChange({ ...value, pan: e.target.value })}
              inputMode="numeric"
              maxLength={11}
              placeholder="9 digits"
              aria-invalid={panBad}
            />
            {panBad && <div className="field-hint error">PAN must be 9 digits.</div>}
          </div>
          <div className="field">
            <label>Buyer address</label>
            <input
              value={value.address ?? ''}
              onChange={(e) => onChange({ ...value, address: e.target.value })}
              maxLength={300}
            />
          </div>
        </div>
      )}
    </div>
  );
}
