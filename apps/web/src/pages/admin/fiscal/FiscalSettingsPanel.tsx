import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, Receipt, Save, ShieldCheck } from 'lucide-react';
import { normalizePAN, type FiscalProfile, type FiscalProfilePatch, type FiscalRegistration } from '@cafe-mgmt/api-types';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { useEnableFiscalMode, useFiscalProfile, useUpdateFiscalProfile } from '@/lib/api';
import { toast } from '@/lib/toast';

// Settings → Tax & IRD. The café's IRD registration and the one-way switch
// that turns every settle into a numbered IRD invoice (docs/ird/COMPLIANCE.md).
// Owner only (fiscal:manage); the tab is hidden for everyone else.

const REGISTRATIONS: { key: FiscalRegistration; label: string; hint: string }[] = [
  {
    key: 'none',
    label: 'Not registered',
    hint: 'Receipts are marked “Not a tax invoice”. Use this if the café bills from an IRD bill book or is not registered.',
  },
  {
    key: 'pan',
    label: 'PAN only',
    hint: 'Registered for income tax only. Bills are titled “Invoice” and carry no VAT.',
  },
  {
    key: 'vat',
    label: 'VAT registered',
    hint: 'Bills are “Tax Invoices” with 13% VAT. Menu prices must include VAT (VAT Rule 14ख).',
  },
];

type Form = Required<FiscalProfilePatch>;

function toForm(p: FiscalProfile): Form {
  return {
    registration_type: p.registration_type,
    pan: p.pan,
    legal_name: p.legal_name,
    legal_name_ne: p.legal_name_ne,
    address: p.address,
    phone: p.phone,
    email: p.email,
    tax_office: p.tax_office,
    permit_no: p.permit_no,
    outlet_code: p.outlet_code,
  };
}

export function FiscalSettingsPanel() {
  const profile = useFiscalProfile();
  const update = useUpdateFiscalProfile();
  const enable = useEnableFiscalMode();
  const [form, setForm] = useState<Form | null>(null);
  const [confirmPan, setConfirmPan] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (profile.data) setForm(toForm(profile.data));
  }, [profile.data]);

  if (profile.isPending) return <LoadingState />;
  if (profile.isError || !profile.data || !form) {
    return <ErrorState onRetry={() => profile.refetch()} />;
  }

  const p = profile.data;
  const locked = p.fiscal_mode;
  const saved = toForm(p);
  const dirty = (Object.keys(form) as (keyof Form)[]).some((k) => form[k] !== saved[k]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });

  const save = async () => {
    setErr(null);
    if (form.registration_type !== 'none' && !normalizePAN(form.pan)) {
      setErr('PAN must be 9 digits.');
      return;
    }
    const patch: FiscalProfilePatch = {};
    (Object.keys(form) as (keyof Form)[]).forEach((k) => {
      if (form[k] !== saved[k]) (patch as Record<string, string>)[k] = form[k];
    });
    try {
      await update.mutateAsync(patch);
      toast.success('Tax profile saved');
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? 'Save failed';
      setErr(msg);
    }
  };

  const doEnable = async () => {
    setErr(null);
    try {
      await enable.mutateAsync({ confirm_pan: confirmPan });
      setConfirmPan('');
      toast.success('IRD invoicing is on', 'Every settled bill now issues a numbered IRD invoice.');
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Could not switch on IRD invoicing');
    }
  };

  const ready = p.readiness.length === 0 && !dirty;

  return (
    <div className="fiscal-panel">
      {err && <div className="banner-error">{err}</div>}

      <div className="tab-section" style={{ maxWidth: '100%' }}>
        <h2>
          <Receipt size={16} strokeWidth={1.6} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          Tax &amp; IRD
        </h2>
        <p className="tab-sub">
          How the café is registered with the Inland Revenue Department, printed on every bill.
        </p>

        {locked ? (
          <div className="banner-info" role="status">
            <ShieldCheck size={14} strokeWidth={1.8} /> IRD invoicing has been on since{' '}
            {p.fiscal_mode_enabled_at ? new Date(p.fiscal_mode_enabled_at).toLocaleDateString() : '—'}.
            Registration type, PAN and outlet code are locked; issued invoices can never be edited or deleted.
          </div>
        ) : null}

        <div className="field" style={{ marginBottom: 18 }}>
          <label>Registration</label>
          <div className="filter-row">
            {REGISTRATIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`chip ${form.registration_type === r.key ? 'active' : ''}`}
                disabled={locked}
                onClick={() => set('registration_type', r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="field-hint">
            {REGISTRATIONS.find((r) => r.key === form.registration_type)?.hint}
          </div>
        </div>

        {form.registration_type !== 'none' && (
          <div className="locale-grid">
            <div className="field">
              <label>
                PAN / VAT number {locked && <Lock size={10} strokeWidth={1.8} aria-label="locked" />}
              </label>
              <input
                value={form.pan}
                onChange={(e) => set('pan', e.target.value)}
                inputMode="numeric"
                placeholder="9 digits"
                maxLength={11}
                disabled={locked}
              />
            </div>
            <div className="field">
              <label>
                Outlet code {locked && <Lock size={10} strokeWidth={1.8} aria-label="locked" />}
              </label>
              <input
                value={form.outlet_code}
                onChange={(e) => set('outlet_code', e.target.value.toUpperCase())}
                placeholder="optional, e.g. KTM"
                maxLength={6}
                disabled={locked}
              />
              <div className="field-hint">
                Needed when several branches bill under one PAN: each branch gets its own code, printed in
                its bill numbers.
              </div>
            </div>
            <div className="field">
              <label>Registered name</label>
              <input value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} maxLength={200} />
            </div>
            <div className="field">
              <label>Registered name (नेपाली)</label>
              <input
                value={form.legal_name_ne}
                onChange={(e) => set('legal_name_ne', e.target.value)}
                maxLength={200}
                lang="ne"
              />
            </div>
            <div className="field">
              <label>Registered address</label>
              <input value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={300} />
            </div>
            <div className="field">
              <label>Phone</label>
              <input value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={200} />
            </div>
            <div className="field">
              <label>Tax office</label>
              <input
                value={form.tax_office}
                onChange={(e) => set('tax_office', e.target.value)}
                placeholder="e.g. Inland Revenue Office, Kathmandu"
                maxLength={200}
              />
            </div>
            <div className="field">
              <label>IRD permit number</label>
              <input
                value={form.permit_no}
                onChange={(e) => set('permit_no', e.target.value)}
                placeholder="from the Annex-4 permit, once granted"
                maxLength={60}
              />
            </div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn primary" disabled={!dirty || update.isPending} onClick={save}>
            <Save size={14} strokeWidth={1.5} />
            {update.isPending ? 'Saving…' : 'Save tax profile'}
          </button>
        </div>
      </div>

      {!locked && form.registration_type !== 'none' && (
        <div className="tab-section" style={{ maxWidth: '100%' }}>
          <h2>Switch on IRD invoicing</h2>
          <p className="tab-sub">
            Do this only once the tax office has granted the café its electronic billing permit.
          </p>

          {dirty ? (
            <div className="field-hint">Save the profile first.</div>
          ) : p.readiness.length > 0 ? (
            <ul className="fiscal-readiness">
              {p.readiness.map((r) => (
                <li key={r.code}>
                  <AlertTriangle size={13} strokeWidth={1.8} /> {r.message}
                </li>
              ))}
            </ul>
          ) : (
            <div className="field-hint">
              <CheckCircle2 size={13} strokeWidth={1.8} /> The profile is complete.
            </div>
          )}

          <div className="banner-warn" style={{ margin: '12px 0' }}>
            <AlertTriangle size={14} strokeWidth={1.8} /> This cannot be undone. From the moment it is on, every
            settled bill gets the next number in this fiscal year's series and is reported to IRD. Issued bills
            can never be edited or deleted. Mistakes are corrected with a sales return or a same-day
            cancellation (reverse entry).
          </div>

          <div className="field" style={{ maxWidth: 280 }}>
            <label>Type the PAN to confirm</label>
            <input
              value={confirmPan}
              onChange={(e) => setConfirmPan(e.target.value)}
              inputMode="numeric"
              placeholder={p.pan || '9 digits'}
              disabled={!ready}
            />
          </div>
          <button
            type="button"
            className="btn danger"
            disabled={!ready || normalizePAN(confirmPan) !== p.pan || enable.isPending}
            onClick={doEnable}
          >
            <ShieldCheck size={14} strokeWidth={1.6} />
            {enable.isPending ? 'Switching on…' : 'Switch on IRD invoicing'}
          </button>
        </div>
      )}
    </div>
  );
}
