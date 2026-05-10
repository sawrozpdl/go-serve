import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Upload, Save } from 'lucide-react';

import { MOODS, type MoodKey } from '@cafe-mgmt/design-tokens';

import {
  useMe,
  useTenantSettings,
  useUpdateTenant,
  useUploadTenantLogo,
  type TenantBranding,
} from '@/lib/api';
import { toast } from '@/lib/toast';

const EMOJI_PALETTE = ['☕', '🥐', '🍵', '🥖', '🍣', '🍝', '🍪', '🌿', '🍷', '🎷', '🍰', '🥗'];

const PRESETS: { name: string; primary: string; accent: string }[] = [
  { name: 'sahan amber', primary: '#FFA319', accent: '#A3F02C' },
  { name: 'rosé pink', primary: '#FF4FA0', accent: '#FFE066' },
  { name: 'forest', primary: '#2BB07F', accent: '#FFD93D' },
  { name: 'cobalt', primary: '#3D7BFF', accent: '#A3F02C' },
  { name: 'crimson', primary: '#E54B4B', accent: '#FFB534' },
];

export function SettingsPage() {
  const me = useMe();
  const tenant = useTenantSettings();
  const update = useUpdateTenant();
  const uploadLogo = useUploadTenantLogo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  const role = me.data?.active_role;
  if (role && role !== 'owner') {
    return <Navigate to="/admin" replace />;
  }

  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const [vatPct, setVatPct] = useState('');
  const [servicePct, setServicePct] = useState('');
  const [brand, setBrand] = useState<TenantBranding>({});

  // Sync form with the loaded tenant object (one-way; user edits flow back via submit).
  const last = useRef<string>('');
  useEffect(() => {
    if (!tenant.data) return;
    const sig = `${tenant.data.name}-${tenant.data.timezone}-${JSON.stringify(tenant.data.branding)}`;
    if (sig === last.current) return;
    last.current = sig;
    setName(tenant.data.name);
    setTz(tenant.data.timezone);
    setVatPct(tenant.data.vat_pct);
    setServicePct(tenant.data.service_charge_pct);
    setBrand(tenant.data.branding ?? {});
  }, [tenant.data]);

  const onPickPreset = (p: typeof PRESETS[number]) => {
    setBrand({ ...brand, brandPrimary: p.primary, brandAccent: p.accent });
  };

  const onPickMood = (m: typeof MOODS[number]) => {
    setBrand({
      ...brand,
      mood: m.key,
      brandPrimary: m.primary,
      brandAccent: m.accent,
      // If they haven't picked an emoji yet, seed it from the mood.
      accentEmoji: brand.accentEmoji ?? m.emoji,
    });
  };

  const onPickEmoji = (e: string | undefined) => {
    setBrand({ ...brand, accentEmoji: e });
  };

  const onUploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null);
    try {
      const r = await uploadLogo.mutateAsync(f);
      setBrand({ ...brand, logoUrl: r.logo_url });
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Upload failed');
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await update.mutateAsync({
        name,
        timezone: tz,
        vat_pct: vatPct,
        service_charge_pct: servicePct,
        branding: brand,
      });
      toast.success('Settings saved', 'changes apply across the workspace');
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? 'Save failed';
      setErr(msg);
      toast.error('Could not save', msg);
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">workspace</span>
          <h1>settings.</h1>
        </div>
      </div>

      {err && <div className="banner-error">{err}</div>}

      <form onSubmit={onSubmit}>
        <div className="row-2">
          <section className="panel">
            <div className="panel-head">
              <h3>identity</h3>
              <span className="meta">name + branding</span>
            </div>

            <label>Cafe name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />

            <div className="row-inputs">
              <div>
                <label>Display name (optional)</label>
                <input
                  value={brand.cafeName ?? ''}
                  onChange={(e) => setBrand({ ...brand, cafeName: e.target.value || undefined })}
                  placeholder={name}
                />
              </div>
              <div>
                <label>Slug</label>
                <input value={tenant.data?.slug ?? ''} disabled />
              </div>
            </div>

            <label>Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {brand.logoUrl ? (
                <img
                  src={brand.logoUrl}
                  alt=""
                  style={{
                    width: 56,
                    height: 56,
                    objectFit: 'contain',
                    background: 'var(--ink-1000)',
                    border: '1px solid var(--ink-700)',
                    borderRadius: 2,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 56,
                    height: 56,
                    background: 'var(--ink-1000)',
                    border: '1px dashed var(--ink-700)',
                    borderRadius: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--ink-400)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                  }}
                >
                  none
                </div>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => fileRef.current?.click()}
                disabled={uploadLogo.isPending}
              >
                <Upload size={14} strokeWidth={1.5} />
                {uploadLogo.isPending ? 'uploading…' : 'Upload (≤ 2 MB)'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                onChange={onUploadLogo}
                style={{ display: 'none' }}
              />
              {brand.logoUrl && (
                <button
                  type="button"
                  className="btn icon danger"
                  onClick={() => setBrand({ ...brand, logoUrl: undefined })}
                  title="remove"
                >
                  ×
                </button>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>colors</h3>
              <span className="meta">applied across the app</span>
            </div>

            <label>Brand primary</label>
            <ColorRow
              value={brand.brandPrimary ?? '#FFA319'}
              onChange={(v) => setBrand({ ...brand, brandPrimary: v })}
            />

            <label>Accent</label>
            <ColorRow
              value={brand.brandAccent ?? '#A3F02C'}
              onChange={(v) => setBrand({ ...brand, brandAccent: v })}
            />

            <div
              style={{
                marginTop: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--ink-300)',
              }}
            >
              Quick presets
            </div>
            <div className="filter-row" style={{ marginTop: 6, marginBottom: 0 }}>
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="chip"
                  onClick={() => onPickPreset(p)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      background: p.primary,
                      borderRadius: 2,
                      display: 'inline-block',
                    }}
                  />
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      background: p.accent,
                      borderRadius: 2,
                      display: 'inline-block',
                    }}
                  />
                  {p.name}
                </button>
              ))}
            </div>
          </section>
        </div>

        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>personality</h3>
            <span className="meta">make it feel like your café</span>
          </div>

          <label>Mood preset</label>
          <div className="mood-grid">
            {MOODS.map((m) => (
              <button
                key={m.key}
                type="button"
                className={`mood-card${(brand.mood as MoodKey | undefined) === m.key ? ' sel' : ''}`}
                onClick={() => onPickMood(m)}
              >
                <span className="mood-emoji">{m.emoji}</span>
                <span className="mood-info">
                  <span className="mood-name">{m.name}</span>
                  <span className="mood-blurb">{m.blurb}</span>
                  <span className="mood-swatches">
                    <span className="mood-swatch" style={{ background: m.primary }} />
                    <span className="mood-swatch" style={{ background: m.accent }} />
                  </span>
                </span>
              </button>
            ))}
          </div>

          <label>Tagline (shown under your café name on the dashboard)</label>
          <input
            value={brand.tagline ?? ''}
            onChange={(e) => setBrand({ ...brand, tagline: e.target.value || undefined })}
            placeholder="fresh roast, every morning"
            maxLength={80}
          />

          <label>Mascot emoji</label>
          <div className="emoji-row">
            {EMOJI_PALETTE.map((e) => (
              <button
                key={e}
                type="button"
                className={`emoji-chip${brand.accentEmoji === e ? ' sel' : ''}`}
                onClick={() => onPickEmoji(e)}
                aria-label={`Use ${e} as accent`}
              >
                {e}
              </button>
            ))}
            {brand.accentEmoji && (
              <button
                type="button"
                className="emoji-chip clear"
                onClick={() => onPickEmoji(undefined)}
              >
                clear
              </button>
            )}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--ink-400)',
              marginTop: -8,
            }}
          >
            shows on the sidebar mark and the dashboard greeting.
          </div>
        </section>

        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>locale &amp; tax</h3>
            <span className="meta">applied to every closed order</span>
          </div>
          <div className="row-inputs">
            <div>
              <label>Timezone</label>
              <input
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                placeholder="Asia/Kathmandu"
              />
            </div>
            <div>
              <label>VAT %</label>
              <input value={vatPct} onChange={(e) => setVatPct(e.target.value)} placeholder="13" />
            </div>
          </div>
          <label>Service charge %</label>
          <input
            value={servicePct}
            onChange={(e) => setServicePct(e.target.value)}
            placeholder="0"
          />
        </section>

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button type="submit" className="btn primary" disabled={update.isPending}>
            <Save size={14} strokeWidth={1.5} />
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </>
  );
}

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 40, height: 36, padding: 0, border: '1px solid var(--ink-700)', borderRadius: 2, background: 'transparent' }}
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#FFA319"
        style={{ flex: 1, marginBottom: 0 }}
      />
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 2,
          background: value,
          boxShadow: `0 0 16px -2px ${value}`,
        }}
      />
    </div>
  );
}
