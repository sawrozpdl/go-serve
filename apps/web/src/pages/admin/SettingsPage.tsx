import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Upload,
  Save,
  Lock,
  Percent,
  Type,
  Globe,
  Building2,
  Palette,
  Sparkles,
} from 'lucide-react';

import { MOODS, TYPOGRAPHIES, type MoodKey, type TypographyKey } from '@cafe-mgmt/design-tokens';

import { SearchSelect, type SearchSelectOption } from '@/components/SearchSelect';
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
  { name: 'Sahan Amber', primary: '#FFA319', accent: '#A3F02C' },
  { name: 'Rosé Pink', primary: '#FF4FA0', accent: '#FFE066' },
  { name: 'Forest', primary: '#2BB07F', accent: '#FFD93D' },
  { name: 'Cobalt', primary: '#3D7BFF', accent: '#A3F02C' },
  { name: 'Crimson', primary: '#E54B4B', accent: '#FFB534' },
];

// Curated fallback list — used if the browser doesn't support
// Intl.supportedValuesOf('timeZone'). Covers the cafés we expect to onboard
// first; the full IANA list is available when the runtime supports it.
const FALLBACK_TZ = [
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

function timezoneOptions(): SearchSelectOption[] {
  const supportedValuesOf = (
    Intl as unknown as { supportedValuesOf?: (kind: string) => string[] }
  ).supportedValuesOf;
  const raw = supportedValuesOf ? supportedValuesOf('timeZone') : FALLBACK_TZ;
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' });
  return raw.map((tz) => {
    let offset = '';
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      }).formatToParts(now);
      const z = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      offset = z;
    } catch {
      /* invalid zone (rare) — fall through */
      void fmt;
    }
    const pretty = tz.replace(/_/g, ' ');
    return {
      value: tz,
      label: offset ? `${pretty}  ·  ${offset}` : pretty,
    };
  });
}

type TabKey = 'identity' | 'branding' | 'personality' | 'locale';

const TABS: { key: TabKey; label: string; Icon: typeof Building2 }[] = [
  { key: 'identity', label: 'Identity', Icon: Building2 },
  { key: 'branding', label: 'Branding', Icon: Palette },
  { key: 'personality', label: 'Personality', Icon: Sparkles },
  { key: 'locale', label: 'Locale & Tax', Icon: Globe },
];

export function SettingsPage() {
  const me = useMe();
  const tenant = useTenantSettings();
  const update = useUpdateTenant();
  const uploadLogo = useUploadTenantLogo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  const activeRoles = me.data?.active_roles;
  if (activeRoles && !activeRoles.includes('owner')) {
    return <Navigate to="/admin" replace />;
  }

  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const [vatPct, setVatPct] = useState('');
  const [servicePct, setServicePct] = useState('');
  const [brand, setBrand] = useState<TenantBranding>({});
  const [tab, setTab] = useState<TabKey>('identity');

  // Build the timezone option list once; it's ~400 entries.
  const tzOptions = useMemo(() => timezoneOptions(), []);

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

  const onPickTypography = (key: TypographyKey) => {
    setBrand({ ...brand, typography: key });
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
      toast.success('Settings saved', 'Changes apply across the workspace');
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? 'Save failed';
      setErr(msg);
      toast.error('Could not save', msg);
    }
  };

  const activeMood = brand.mood as MoodKey | undefined;
  const activeTypography: TypographyKey = (brand.typography as TypographyKey | undefined) ?? 'editorial';

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">workspace</span>
          <h1>Settings</h1>
        </div>
      </div>

      {err && <div className="banner-error">{err}</div>}

      <div className="page-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            <Icon size={12} strokeWidth={1.6} />
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit}>
        {tab === 'identity' && (
          <section className="tab-body" role="tabpanel">
            <div className="tab-section">
              <h2>Identity</h2>
              <p className="tab-sub">Name + logo shown across the workspace</p>

              <label>Cafe name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />

              <div className="row-inputs">
                <div>
                  <label>Display name (optional)</label>
                  <input
                    value={brand.cafeName ?? ''}
                    onChange={(e) =>
                      setBrand({ ...brand, cafeName: e.target.value || undefined })
                    }
                    placeholder={name}
                  />
                </div>
                <div>
                  <label>Workspace slug</label>
                  <div className="locked-field">
                    <input value={tenant.data?.slug ?? ''} disabled aria-readonly="true" />
                    <Lock
                      size={13}
                      strokeWidth={1.6}
                      className="locked-icon"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="field-hint">
                    Permanent — appears in URLs and team invites.
                  </div>
                </div>
              </div>

              <label>Logo</label>
              <div className="logo-row">
                {brand.logoUrl ? (
                  <img src={brand.logoUrl} alt="" className="logo-preview" />
                ) : (
                  <div className="logo-empty">none</div>
                )}
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploadLogo.isPending}
                >
                  <Upload size={14} strokeWidth={1.5} />
                  {uploadLogo.isPending ? 'Uploading…' : 'Upload (≤ 2 MB)'}
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
                    title="Remove logo"
                    aria-label="Remove logo"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {tab === 'branding' && (
          <section className="tab-body" role="tabpanel">
            <div className="tab-section">
              <h2>Brand colors</h2>
              <p className="tab-sub">Applied across the app — buttons, accents, highlights</p>

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
            </div>

            <div className="tab-section">
              <h2>Quick presets</h2>
              <p className="tab-sub">Curated palettes to start from</p>
              <div className="filter-row" style={{ marginTop: 0, marginBottom: 0 }}>
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className="chip"
                    onClick={() => onPickPreset(p)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <span className="preset-swatch" style={{ background: p.primary }} />
                    <span className="preset-swatch" style={{ background: p.accent }} />
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {tab === 'personality' && (
          <section className="tab-body" role="tabpanel">
            <div className="tab-section" style={{ maxWidth: '100%' }}>
              <h2>Mood</h2>
              <p className="tab-sub">Pick a vibe — sets colors and a mascot in one tap</p>
              <div className="mood-grid">
                {MOODS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`mood-card${activeMood === m.key ? ' sel' : ''}`}
                    onClick={() => onPickMood(m)}
                    aria-pressed={activeMood === m.key}
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
            </div>

            <div className="tab-section" style={{ maxWidth: '100%' }}>
              <h2>Typography</h2>
              <p className="tab-sub">How headings read across the app</p>
              <div className="type-grid">
                {TYPOGRAPHIES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={`type-card${activeTypography === t.key ? ' sel' : ''}`}
                    onClick={() => onPickTypography(t.key)}
                    aria-pressed={activeTypography === t.key}
                    data-typo={t.key}
                  >
                    <span className={`type-sample type-sample--${t.key}`}>{t.sample}</span>
                    <span className="type-info">
                      <span className="type-name">
                        <Type size={11} strokeWidth={1.6} /> {t.name}
                      </span>
                      <span className="type-blurb">{t.blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="tab-section">
              <h2>Voice</h2>
              <p className="tab-sub">A tagline and mascot that show up around the app</p>

              <label>Tagline</label>
              <input
                value={brand.tagline ?? ''}
                onChange={(e) =>
                  setBrand({ ...brand, tagline: e.target.value || undefined })
                }
                placeholder="fresh roast, every morning"
                maxLength={80}
              />
              <div className="field-hint">Shown under your café name on the dashboard.</div>

              <label style={{ marginTop: 18 }}>Mascot emoji</label>
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
              <div className="field-hint">
                Shows on the sidebar mark and the dashboard greeting.
              </div>
            </div>
          </section>
        )}

        {tab === 'locale' && (
          <section className="tab-body" role="tabpanel">
            <div className="tab-section" style={{ maxWidth: '100%' }}>
              <h2>Locale &amp; Tax</h2>
              <p className="tab-sub">Applied to every closed order and daily report</p>

              <div className="locale-grid">
                <div className="field">
                  <label>
                    <Globe
                      size={11}
                      strokeWidth={1.6}
                      style={{ marginRight: 4, verticalAlign: '-1px' }}
                    />
                    Timezone
                  </label>
                  <SearchSelect
                    options={tzOptions}
                    value={tz}
                    onChange={setTz}
                    placeholder="Search timezones…"
                    allowCustom
                  />
                  <div className="field-hint">
                    Closing reports + day boundaries follow this zone.
                  </div>
                </div>

                <div className="field">
                  <label>VAT</label>
                  <div className="suffix-input">
                    <input
                      value={vatPct}
                      onChange={(e) => setVatPct(e.target.value)}
                      placeholder="13"
                      inputMode="decimal"
                    />
                    <span className="suffix">
                      <Percent size={12} strokeWidth={1.8} />
                    </span>
                  </div>
                  <div className="field-hint">Added to subtotal at order close.</div>
                </div>

                <div className="field">
                  <label>Service charge</label>
                  <div className="suffix-input">
                    <input
                      value={servicePct}
                      onChange={(e) => setServicePct(e.target.value)}
                      placeholder="0"
                      inputMode="decimal"
                    />
                    <span className="suffix">
                      <Percent size={12} strokeWidth={1.8} />
                    </span>
                  </div>
                  <div className="field-hint">
                    Optional staff charge layered on top of VAT.
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="modal-actions" style={{ marginTop: 24 }}>
          <button type="submit" className="btn primary" disabled={update.isPending}>
            <Save size={14} strokeWidth={1.5} />
            {update.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </>
  );
}

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-row">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Color picker"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#FFA319"
        className="color-hex"
      />
      <span
        className="color-swatch"
        style={{ background: value, boxShadow: `0 0 18px -2px ${value}` }}
      />
    </div>
  );
}
