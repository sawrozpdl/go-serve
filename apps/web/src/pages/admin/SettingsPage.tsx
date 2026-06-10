import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
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
  Workflow,
  Shield,
  Download,
  Trash2,
  AlertTriangle,
} from 'lucide-react';

import { MOODS, TYPOGRAPHIES, type MoodKey, type TypographyKey } from '@cafe-mgmt/design-tokens';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { Tabs, type TabItem } from '@/components/Tabs';
import { SaveBar } from '@/components/SaveBar';
import { SearchSelect, type SearchSelectOption } from '@/components/SearchSelect';
import {
  can,
  useMe,
  useTenantSettings,
  useUpdateTenant,
  useUploadTenantLogo,
  useExportMyData,
  useDeleteMyAccount,
  type TenantBranding,
  type TenantPreferences,
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

type TabKey = 'identity' | 'branding' | 'personality' | 'locale' | 'workflow' | 'privacy';

const TAB_ITEMS: TabItem<TabKey>[] = [
  { key: 'identity', label: 'Identity', icon: <Building2 size={12} strokeWidth={1.6} /> },
  { key: 'branding', label: 'Branding', icon: <Palette size={12} strokeWidth={1.6} /> },
  { key: 'personality', label: 'Personality', icon: <Sparkles size={12} strokeWidth={1.6} /> },
  { key: 'workflow', label: 'Workflow', icon: <Workflow size={12} strokeWidth={1.6} /> },
  { key: 'locale', label: 'Locale & Tax', icon: <Globe size={12} strokeWidth={1.6} /> },
  { key: 'privacy', label: 'Privacy & Data', icon: <Shield size={12} strokeWidth={1.6} /> },
];

export function SettingsPage() {
  const me = useMe();
  const tenant = useTenantSettings();
  const update = useUpdateTenant();
  const uploadLogo = useUploadTenantLogo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  if (me.data && !can(me.data, 'tenant:update')) {
    return <Navigate to="/admin" replace />;
  }

  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const [vatPct, setVatPct] = useState('');
  const [servicePct, setServicePct] = useState('');
  const [brand, setBrand] = useState<TenantBranding>({});
  const [prefs, setPrefs] = useState<TenantPreferences>({});
  const [tab, setTab] = useState<TabKey>('identity');

  // Build the timezone option list once; it's ~400 entries.
  const tzOptions = useMemo(() => timezoneOptions(), []);

  // Sync form with the loaded tenant object (one-way; user edits flow back via submit).
  const last = useRef<string>('');
  useEffect(() => {
    if (!tenant.data) return;
    const sig = `${tenant.data.name}-${tenant.data.timezone}-${JSON.stringify(tenant.data.branding)}-${JSON.stringify(tenant.data.preferences)}`;
    if (sig === last.current) return;
    last.current = sig;
    setName(tenant.data.name);
    setTz(tenant.data.timezone);
    setVatPct(tenant.data.vat_pct);
    setServicePct(tenant.data.service_charge_pct);
    setBrand(tenant.data.branding ?? {});
    setPrefs(tenant.data.preferences ?? {});
  }, [tenant.data]);

  // Compare current form state to the loaded tenant to decide if "Save" is
  // meaningful. A "Saved." pill flashes on the sticky bar otherwise, so the
  // owner gets a clear signal that nothing is in flight.
  const dirty = useMemo(() => {
    if (!tenant.data) return false;
    if (name !== tenant.data.name) return true;
    if (tz !== tenant.data.timezone) return true;
    if (vatPct !== tenant.data.vat_pct) return true;
    if (servicePct !== tenant.data.service_charge_pct) return true;
    if (JSON.stringify(brand) !== JSON.stringify(tenant.data.branding ?? {})) return true;
    if (JSON.stringify(prefs) !== JSON.stringify(tenant.data.preferences ?? {})) return true;
    return false;
  }, [tenant.data, name, tz, vatPct, servicePct, brand, prefs]);

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
        preferences: prefs,
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
    <PageShell
      eyebrow="workspace"
      title="Settings"
      tabs={<Tabs items={TAB_ITEMS} active={tab} onChange={setTab} ariaLabel="Settings sections" />}
      footer={
        <SaveBar
          dirty={dirty}
          submitButton={
            <button
              type="submit"
              form="settings-form"
              className="btn primary"
              disabled={update.isPending || !dirty}
            >
              <Save size={14} strokeWidth={1.5} />
              {update.isPending ? 'Saving…' : 'Save changes'}
            </button>
          }
        />
      }
    >
      {err && <div className="banner-error">{err}</div>}

      {tenant.isPending && <LoadingState />}
      {tenant.isError && !tenant.data && <ErrorState onRetry={() => tenant.refetch()} />}

      {tenant.data && (
        <form id="settings-form" onSubmit={onSubmit}>
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

          {tab === 'workflow' && (
            <section className="tab-body" role="tabpanel">
              <div className="tab-section" style={{ maxWidth: '100%' }}>
                <h2>Ordering</h2>
                <p className="tab-sub">
                  How items land on a tab. Pick the defaults that match your floor.
                </p>

                <ToggleRow
                  label="Stack repeated items"
                  hint="Tapping the same menu item again bumps the existing line's quantity instead of creating a duplicate row. Keeps long tabs scannable (Americano ×4 vs four separate Americano lines)."
                  checked={prefs.stackItems ?? true}
                  onChange={(v) => setPrefs({ ...prefs, stackItems: v })}
                />
              </div>

              <div className="tab-section" style={{ maxWidth: '100%' }}>
                <h2>Kitchen &amp; tables</h2>
                <p className="tab-sub">
                  Tune the product lifecycle to match how your floor actually moves.
                </p>

                <ToggleRow
                  label="Auto-serve when kitchen marks ready"
                  hint="Skip the separate 'serve' tap — once the kitchen flips an item to ready, treat it as served. Useful for cafés where the cook hands the plate directly to the customer."
                  checked={!!prefs.autoServeOnReady}
                  onChange={(v) => setPrefs({ ...prefs, autoServeOnReady: v })}
                />
                <ToggleRow
                  label="Auto-clean tables on close"
                  hint="When a tab is closed, return the table directly to free (no dirty state, no 'mark clean' step). Pick this for counter-service or take-away-first floors."
                  checked={!!prefs.autoCleanTables}
                  onChange={(v) => setPrefs({ ...prefs, autoCleanTables: v })}
                />
              </div>

              <div className="tab-section" style={{ maxWidth: '100%' }}>
                <h2>Payments</h2>
                <p className="tab-sub">
                  Speed up the cash-out moment. Each toggle removes a tap.
                </p>

                <ToggleRow
                  label="Auto-record payment on amount change"
                  hint="Typing into the Amount field automatically records the payment after a brief pause — no 'Add payment' tap needed. Switch the method chip to record against a different method."
                  checked={prefs.autoRecordPayment ?? true}
                  onChange={(v) => setPrefs({ ...prefs, autoRecordPayment: v })}
                />
                <ToggleRow
                  label="Ask for txn reference on online payments"
                  hint="Shows a 'Txn reference' field for eSewa / Khalti / card payments. Off by default — most cashiers skip it and the system tracks the amount alone."
                  checked={!!prefs.requireTxnRef}
                  onChange={(v) => setPrefs({ ...prefs, requireTxnRef: v })}
                />
                <ToggleRow
                  label="Combined discount + settle modal"
                  hint="Show discount controls inside the settle screen so the cashier can apply and collect in one place. The standalone Discount button is hidden when this is on."
                  checked={!!prefs.combinedSettle}
                  onChange={(v) => setPrefs({ ...prefs, combinedSettle: v })}
                />
              </div>

              <div className="tab-section" style={{ maxWidth: '100%' }}>
                <h2>Discounts</h2>
                <p className="tab-sub">
                  How the discount form behaves. Defaults below pre-fill common cases.
                </p>

                <ToggleRow
                  label="Auto-apply on amount change"
                  hint="Each typed amount applies as a separate discount adjustment after a brief pause. Use the × on a chip to remove an over-shoot. Off → manual 'Apply' button."
                  checked={prefs.discountAutoApply ?? true}
                  onChange={(v) => setPrefs({ ...prefs, discountAutoApply: v })}
                />

                <div className="row-inputs" style={{ marginTop: 18 }}>
                  <div>
                    <label>Default amount mode</label>
                    <div className="filter-row">
                      <button
                        type="button"
                        className={`chip ${(prefs.defaultDiscount?.mode ?? 'flat') === 'flat' ? 'active' : ''}`}
                        onClick={() =>
                          setPrefs({
                            ...prefs,
                            defaultDiscount: { ...(prefs.defaultDiscount ?? {}), mode: 'flat' },
                          })
                        }
                      >
                        flat NPR off
                      </button>
                      <button
                        type="button"
                        className={`chip ${prefs.defaultDiscount?.mode === 'percent' ? 'active' : ''}`}
                        onClick={() =>
                          setPrefs({
                            ...prefs,
                            defaultDiscount: { ...(prefs.defaultDiscount ?? {}), mode: 'percent' },
                          })
                        }
                      >
                        % off
                      </button>
                    </div>
                  </div>
                  <div>
                    <label>Default reason</label>
                    <SearchSelect
                      options={[
                        { value: 'regular', label: 'Regular' },
                        { value: 'promotion', label: 'Promotion' },
                        { value: 'birthday', label: 'Birthday' },
                        { value: 'staff', label: 'Staff' },
                        { value: 'friends', label: 'Friends' },
                        { value: 'other', label: 'Other' },
                      ]}
                      value={prefs.defaultDiscount?.reason ?? 'regular'}
                      onChange={(v) =>
                        setPrefs({
                          ...prefs,
                          defaultDiscount: { ...(prefs.defaultDiscount ?? {}), reason: v },
                        })
                      }
                    />
                  </div>
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

          {tab === 'privacy' && (
            <section className="tab-body" role="tabpanel">
              <PrivacyTab />
            </section>
          )}

        </form>
      )}
    </PageShell>
  );
}

// Phrase the user must type verbatim to arm the delete button.
const DELETE_PHRASE = 'DELETE';

function PrivacyTab() {
  const me = useMe();
  const exporter = useExportMyData();
  const deleter = useDeleteMyAccount();
  const nav = useNavigate();

  // The backend rejects a sole-owner self-delete (409 sole_owner). We mirror
  // that up front: surface every workspace the user owns so the consequence
  // is obvious before they ever arm the button.
  const ownedWorkspaces = (me.data?.memberships ?? [])
    .filter((m) => m.status === 'active' && m.roles.includes('owner'))
    .map((m) => m.tenant_name);
  const isOwner = ownedWorkspaces.length > 0;

  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const armed = phrase.trim().toUpperCase() === DELETE_PHRASE;

  const resetConfirm = () => {
    setConfirming(false);
    setPhrase('');
    setBlocked(null);
  };

  const onExport = async () => {
    try {
      await exporter.mutateAsync();
      toast.success('Export ready', 'check your downloads folder');
    } catch (e: unknown) {
      toast.error('Export failed', (e as { message?: string }).message);
    }
  };

  const onDelete = async () => {
    if (!armed || deleter.isPending) return;
    setBlocked(null);
    try {
      await deleter.mutateAsync();
      toast.success('Account deleted', 'you have been signed out');
      nav('/login', { replace: true });
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string; workspaces?: string[] };
      if (err.code === 'sole_owner') {
        // Hard block: list the workspaces and keep the panel open.
        setBlocked(err.workspaces && err.workspaces.length > 0 ? err.workspaces : ownedWorkspaces);
        return;
      }
      toast.error('Could not delete', err.message ?? 'Failed');
    }
  };

  return (
    <div className="tab-section" style={{ maxWidth: '100%' }}>
      <h2>Your data</h2>
      <p className="tab-sub">
        Download a copy of the personal data we hold about you, or permanently
        delete your account.
      </p>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          marginTop: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            padding: 16,
            background: 'var(--ink-900)',
            border: '1px solid var(--ink-800)',
            borderRadius: 10,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, color: 'var(--ink-50)', marginBottom: 4 }}>
              Export your data
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-400)' }}>
              Downloads a JSON file with your profile, workspace memberships,
              and active session count.
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={onExport}
            disabled={exporter.isPending}
          >
            <Download size={14} strokeWidth={1.5} />
            {exporter.isPending ? 'Preparing…' : 'Download export'}
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            padding: 16,
            background: 'rgba(255, 100, 100, 0.04)',
            border: '1px solid rgba(255, 100, 100, 0.25)',
            borderRadius: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, color: 'var(--ink-50)', marginBottom: 4 }}>
                Delete account
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-400)' }}>
                Permanent. Revokes sessions, anonymizes your identity, and
                removes you from every workspace. Historical records remain
                intact but reference your name as a snapshot.
              </div>
            </div>
            {!confirming && (
              <button
                type="button"
                className="btn danger"
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={14} strokeWidth={1.5} />
                Delete account
              </button>
            )}
          </div>

          {confirming && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                paddingTop: 14,
                borderTop: '1px solid rgba(255, 100, 100, 0.22)',
              }}
            >
              {isOwner && (
                <div className="banner-info" style={{ marginBottom: 0 }}>
                  <AlertTriangle size={14} strokeWidth={1.8} />
                  <span>
                    You own{' '}
                    <strong>
                      {ownedWorkspaces.length === 1
                        ? ownedWorkspaces[0]
                        : `${ownedWorkspaces.length} workspaces`}
                    </strong>
                    . If you're the only owner, deletion is blocked — transfer
                    ownership to another member on the Team page first.
                  </span>
                </div>
              )}

              {blocked && (
                <div className="banner-error" style={{ marginBottom: 0 }}>
                  Can't delete — you're the only active owner of{' '}
                  {blocked.join(', ')}. Transfer ownership before deleting your
                  account.
                </div>
              )}

              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="delete-confirm">
                  Type {DELETE_PHRASE} to confirm
                </label>
                <input
                  id="delete-confirm"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  placeholder={DELETE_PHRASE}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ maxWidth: 240 }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={resetConfirm}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={onDelete}
                  disabled={!armed || deleter.isPending}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {deleter.isPending ? 'Deleting…' : 'Delete account permanently'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-row-text">
        <div className="toggle-row-label">{label}</div>
        <div className="toggle-row-hint">{hint}</div>
      </div>
      <button
        type="button"
        className={`switch${checked ? ' on' : ''}`}
        aria-pressed={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
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
