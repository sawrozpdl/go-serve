import { useEffect, useState } from 'react';
import { FileText, Save } from 'lucide-react';
import type { IrdPlatformProfile } from '@cafe-mgmt/api-types';
import { ErrorState } from '@/components/ErrorState';
import { PageShell } from '@/components/PageShell';
import { LoadingState } from '@/components/LoadingState';
import { openAuthedDocument, useIrdPlatformProfile, useUpdateIrdPlatformProfile } from '@/lib/api';
import { toast } from '@/lib/toast';

// /super/ird — the producer (your company, which lists Go Serve with IRD) and
// the data centre. Every café's IRD forms are filled from these values.

const PRODUCER: [keyof IrdPlatformProfile['producer'], string][] = [
  ['company', 'Company name (English)'],
  ['company_ne', 'Company name (नेपाली)'],
  ['pan', 'PAN'],
  ['address', 'Registered address (English)'],
  ['address_ne', 'Registered address (नेपाली)'],
  ['tax_office', 'Tax office'],
  ['registered_on', 'Registration date (BS)'],
  ['director', 'Managing director'],
  ['director_title', 'Signatory title'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['mobile', 'Mobile'],
  ['website', 'Website'],
  ['software_name', 'Software name as listed'],
  ['enlisted_no', 'IRD enlisted no. (after listing)'],
  ['enlisted_on', 'Enlisted on (BS)'],
];

const DATACENTER: [keyof IrdPlatformProfile['datacenter'], string][] = [
  ['company', 'Data centre company'],
  ['pan', 'PAN'],
  ['address', 'Address'],
  ['phone', 'Phone'],
  ['contact', 'Contact person'],
  ['location', 'Location of data centre'],
  ['server_ip', 'Server / VPS IP'],
  ['server_type', 'Server type'],
  ['hosting_model', 'VPS / Co-located / Bare metal'],
  ['tier', 'Compliance / tier'],
  ['dr_site', 'DR site address (in Nepal)'],
  ['database', 'Database and version'],
  ['ssl', 'SSL enabled'],
  ['domain', 'URL / domain'],
];

export function SuperIrdPage() {
  const q = useIrdPlatformProfile();
  const save = useUpdateIrdPlatformProfile();
  const [p, setP] = useState<IrdPlatformProfile | null>(null);

  useEffect(() => {
    if (q.data) setP({ producer: { ...q.data.producer }, datacenter: { ...q.data.datacenter } });
  }, [q.data]);

  if (q.isPending) return <LoadingState />;
  if (q.isError || !p) return <ErrorState onRetry={() => q.refetch()} />;

  const onSave = async () => {
    try {
      await save.mutateAsync(p);
      toast.success('IRD profile saved');
    } catch (e: unknown) {
      toast.error('Could not save', (e as { message?: string }).message ?? '');
    }
  };

  return (
    <PageShell eyebrow="Compliance" title="IRD listing">
      <p className="muted">
        Producer and data-centre details printed on every café's IRD forms (Annex 1, 2, 3, 7). See
        docs/ird/COMPLIANCE.md for the listing steps.
      </p>
      <h2>Producer</h2>
      <div className="purchase-grid">
        {PRODUCER.map(([k, label]) => (
          <div key={k} className="field">
            <label>{label}</label>
            <input value={p.producer[k] ?? ''} onChange={(e) => setP({ ...p, producer: { ...p.producer, [k]: e.target.value } })} />
          </div>
        ))}
      </div>
      <h2>Data centre</h2>
      <div className="purchase-grid">
        {DATACENTER.map(([k, label]) => (
          <div key={k} className="field">
            <label>{label}</label>
            <input
              value={p.datacenter[k] ?? ''}
              onChange={(e) => setP({ ...p, datacenter: { ...p.datacenter, [k]: e.target.value } })}
            />
          </div>
        ))}
      </div>
      <div className="filter-row" style={{ marginTop: 16, gap: 8 }}>
        <button type="button" className="btn primary" disabled={save.isPending} onClick={onSave}>
          <Save size={14} strokeWidth={1.5} /> {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            openAuthedDocument('/v1/super/ird/documents/annex1_listing').catch((e: unknown) =>
              toast.error('Could not open', (e as { message?: string }).message ?? ''),
            )
          }
        >
          <FileText size={14} strokeWidth={1.5} /> Annex 1 (listing values)
        </button>
      </div>
    </PageShell>
  );
}
