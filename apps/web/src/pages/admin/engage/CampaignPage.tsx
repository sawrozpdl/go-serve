import { useEffect, useRef, useState } from 'react';
import { QrCode } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { SaveBar } from '@/components/SaveBar';
import { parsePriceInput, formatNPR } from '@/components/Money';
import { useConfirm } from '@/components/ConfirmDialog';
import { PublicMenuShareModal } from '@/components/PublicMenuShareModal';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { useTenantSettings } from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import {
  useEngageCampaign,
  useInvalidateEngageCodes,
  useSaveEngageCampaign,
  useSetEngageStatus,
  type EngageCampaign,
} from '@/lib/engage';

// =========================================================================
// Campaign tab — what the guest sees and what it may cost.
//
// Follows SettingsPage's editing model: local state hydrated ONCE per café (so
// a background refetch can't clobber unsaved edits), a JSON dirty check, and a
// SaveBar in the shell footer.
//
// Going live is deliberately NOT part of Save. Editing copy must never switch
// the café's QR on by accident, so status is its own immediate action.
// =========================================================================

const GAMES: { key: EngageCampaign['game']; name: string; rule: string; a11y: string }[] = [
  {
    key: 'tea_runner',
    name: 'Tea Runner',
    rule: 'Tap to keep the cup flying through the gaps.',
    a11y: 'Fast reflexes needed — the most game-like of the three.',
  },
  {
    key: 'memory_match',
    name: 'Memory Match',
    rule: 'Find the matching pairs before the timer runs out.',
    a11y: 'No reflexes needed, and it works with a keyboard or a screen reader. Pick this if you want everyone to join in.',
  },
  {
    key: 'stack',
    name: 'Stack',
    rule: 'Tap to drop each block and keep the tower wide.',
    a11y: 'One tap, timed — gentler than Tea Runner but still needs timing.',
  },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A blank campaign, so the first-run editor has something coherent to edit. */
function emptyCampaign(): Partial<EngageCampaign> {
  return {
    name: 'Guest rewards',
    game: 'tea_runner',
    difficulty: 'normal',
    reward_ttl_seconds: 300,
    grace_seconds: 600,
    allow_claim_without_play: false,
    contact_capture_enabled: true,
    active_days: [],
    headline: 'Play for a treat',
    subhead: '',
    terms_text: '',
    budget_total_cents: null,
    budget_daily_cents: null,
    budget_daily_count: null,
    starts_on: null,
    ends_on: null,
    active_from: null,
    active_to: null,
  };
}

export function CampaignPage() {
  const { can } = usePermissions();
  const confirm = useConfirm();
  const { slug } = useTenant();
  const tenant = useTenantSettings();
  const q = useEngageCampaign();
  const save = useSaveEngageCampaign();
  const setStatus = useSetEngageStatus();
  const invalidate = useInvalidateEngageCodes();

  const editable = can('engage:update');
  const [form, setForm] = useState<Partial<EngageCampaign>>(emptyCampaign());
  const [shareOpen, setShareOpen] = useState(false);
  const hydratedFor = useRef<string | null>(null);

  // Hydrate once per café. A refetch mid-edit must not throw away typing.
  useEffect(() => {
    if (!q.data || hydratedFor.current === slug) return;
    hydratedFor.current = slug ?? null;
    setForm(q.data.campaign ? { ...q.data.campaign } : emptyCampaign());
  }, [q.data, slug]);

  const saved = q.data?.campaign;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved ?? emptyCampaign());
  const status = saved?.status ?? 'draft';
  const live = status === 'active';

  const set = <K extends keyof EngageCampaign>(key: K, value: EngageCampaign[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await save.mutateAsync(form);
      toast.success('Campaign saved');
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    }
  };

  const toggleLive = async () => {
    try {
      await setStatus.mutateAsync(live ? 'paused' : 'active');
      toast.success(live ? 'Campaign paused' : 'Campaign is live');
    } catch (err) {
      toast.error(live ? 'Could not pause' : 'Could not go live', (err as Error).message);
    }
  };

  const playUrl = slug ? `${window.location.origin}/play/${slug}` : '';

  return (
    <PageShell
      eyebrow="grow"
      title="Engage"
      docTitle="Engage · Campaign"
      footer={
        editable ? (
          <SaveBar
            dirty={dirty}
            submitButton={
              <button type="submit" form="engage-campaign" className="btn primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save campaign'}
              </button>
            }
          />
        ) : undefined
      }
    >
      <QueryState isPending={q.isPending} isError={q.isError} error={q.error} refetch={q.refetch}>
        <form id="engage-campaign" onSubmit={submit} className="engage-form">
            {/* ---------------------------------------------------------
                Status — its own immediate action, never part of Save.
                --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>Status</h3>
                <span className={`pill ${live ? 'ok' : ''}`}>{live ? 'Live' : status}</span>
              </div>
              <p className="engage-hint">
                {live
                  ? 'Guests scanning your table tents can play right now.'
                  : 'Nothing is running. Guests who scan will see a friendly "no game right now".'}
              </p>
              {editable && saved && (
                <div className="engage-actions">
                  <button
                    type="button"
                    className={`btn ${live ? '' : 'primary'}`}
                    onClick={() => void toggleLive()}
                    disabled={setStatus.isPending}
                  >
                    {live ? 'Pause campaign' : 'Go live'}
                  </button>
                  <a className="btn" href={playUrl} target="_blank" rel="noreferrer">
                    Preview as a guest
                  </a>
                </div>
              )}
              {!saved && <p className="engage-hint">Save the campaign first, then add rewards and go live.</p>}
            </section>

            {/* --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>The game</h3>
              </div>
              <div className="engage-games">
                {GAMES.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`engage-game${form.game === g.key ? ' is-on' : ''}`}
                    onClick={() => editable && set('game', g.key)}
                    aria-pressed={form.game === g.key}
                    disabled={!editable}
                  >
                    <span className="engage-game__name">{g.name}</span>
                    <span className="engage-game__rule">{g.rule}</span>
                    {/* Surfaced so an owner can choose deliberately rather than
                        discovering later that half their guests can't play. */}
                    <span className="engage-game__a11y">{g.a11y}</span>
                  </button>
                ))}
              </div>

              <label className="field">
                <span className="field-label">Difficulty</span>
                <select
                  value={form.difficulty ?? 'normal'}
                  onChange={(e) => set('difficulty', e.target.value as EngageCampaign['difficulty'])}
                  disabled={!editable}
                >
                  <option value="gentle">Gentle</option>
                  <option value="normal">Normal</option>
                  <option value="tricky">Tricky</option>
                </select>
                <span className="field-hint">
                  This changes how the game feels, not what it costs you — your reward tiers control that.
                </span>
              </label>
            </section>

            {/* --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>What guests see</h3>
              </div>
              <label className="field">
                <span className="field-label">Campaign name</span>
                <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} disabled={!editable} maxLength={120} />
                <span className="field-hint">For your reference only — guests never see this.</span>
              </label>
              <label className="field">
                <span className="field-label">Headline</span>
                <input value={form.headline ?? ''} onChange={(e) => set('headline', e.target.value)} disabled={!editable} maxLength={120} />
              </label>
              <label className="field">
                <span className="field-label">Sub-heading</span>
                <input value={form.subhead ?? ''} onChange={(e) => set('subhead', e.target.value)} disabled={!editable} maxLength={240} />
              </label>
              <label className="field">
                <span className="field-label">Terms</span>
                <textarea rows={2} value={form.terms_text ?? ''} onChange={(e) => set('terms_text', e.target.value)} disabled={!editable} maxLength={2000} />
                <span className="field-hint">Shown small under the reward. Worth stating the one-a-day rule.</span>
              </label>
            </section>

            {/* --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>When it runs</h3>
              </div>
              <div className="engage-grid">
                <label className="field">
                  <span className="field-label">Starts</span>
                  <input type="date" value={form.starts_on ?? ''} onChange={(e) => set('starts_on', e.target.value || null)} disabled={!editable} />
                </label>
                <label className="field">
                  <span className="field-label">Ends</span>
                  <input type="date" value={form.ends_on ?? ''} onChange={(e) => set('ends_on', e.target.value || null)} disabled={!editable} />
                  <span className="field-hint">Leave empty to run until you pause it.</span>
                </label>
                <label className="field">
                  <span className="field-label">From</span>
                  <input type="time" value={form.active_from ?? ''} onChange={(e) => set('active_from', e.target.value || null)} disabled={!editable} />
                </label>
                <label className="field">
                  <span className="field-label">Until</span>
                  <input type="time" value={form.active_to ?? ''} onChange={(e) => set('active_to', e.target.value || null)} disabled={!editable} />
                </label>
              </div>
              <div className="field">
                <span className="field-label">Days</span>
                <div className="engage-days">
                  {DAYS.map((d, i) => {
                    const on = (form.active_days ?? []).includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        className={`btn small${on ? ' primary' : ''}`}
                        disabled={!editable}
                        onClick={() => {
                          const days = new Set(form.active_days ?? []);
                          if (on) days.delete(i);
                          else days.add(i);
                          set('active_days', [...days].sort((a, b) => a - b));
                        }}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
                <span className="field-hint">None selected = every day.</span>
              </div>
            </section>

            {/* ---------------------------------------------------------
                The five-minute rule.
                --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>The reward window</h3>
              </div>
              <p className="engage-hint">
                A won reward is only good for a few minutes, so it has to be used here and now. That is what
                stops codes being shared or saved up — and it is why nobody can farm your campaign from home.
              </p>
              <div className="engage-grid">
                <label className="field">
                  <span className="field-label">Reward lasts</span>
                  <select
                    value={String(form.reward_ttl_seconds ?? 300)}
                    onChange={(e) => set('reward_ttl_seconds', Number(e.target.value))}
                    disabled={!editable}
                  >
                    {[120, 180, 300, 600, 900, 1800].map((s) => (
                      <option key={s} value={s}>
                        {s / 60} minutes
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Counter grace</span>
                  <select
                    value={String(form.grace_seconds ?? 600)}
                    onChange={(e) => set('grace_seconds', Number(e.target.value))}
                    disabled={!editable}
                  >
                    {[0, 300, 600, 1200, 1800].map((s) => (
                      <option key={s} value={s}>
                        {s === 0 ? 'None' : `${s / 60} minutes`}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    How long after expiry your staff can still honour a code. A guest shouldn't lose their
                    prize because your queue was long.
                  </span>
                </label>
              </div>
            </section>

            {/* --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>Budget caps</h3>
              </div>
              <p className="engage-hint">
                Checked before a guest plays, never after. If the day's budget is gone the page opens in
                practice mode — nobody wins something you then have to refuse.
              </p>
              <div className="engage-grid">
                <label className="field">
                  <span className="field-label">Rewards per day</span>
                  <input
                    inputMode="numeric"
                    value={form.budget_daily_count ?? ''}
                    onChange={(e) => set('budget_daily_count', e.target.value ? Number(e.target.value) : null)}
                    disabled={!editable}
                    placeholder="No limit"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Value per day</span>
                  <input
                    inputMode="decimal"
                    value={form.budget_daily_cents != null ? String(form.budget_daily_cents / 100) : ''}
                    onChange={(e) => set('budget_daily_cents', e.target.value ? parsePriceInput(e.target.value) : null)}
                    disabled={!editable}
                    placeholder="No limit"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Total for the campaign</span>
                  <input
                    inputMode="decimal"
                    value={form.budget_total_cents != null ? String(form.budget_total_cents / 100) : ''}
                    onChange={(e) => set('budget_total_cents', e.target.value ? parsePriceInput(e.target.value) : null)}
                    disabled={!editable}
                    placeholder="No limit"
                  />
                </label>
              </div>
              {form.budget_daily_cents != null && (
                <p className="engage-hint">
                  At most {formatNPR(form.budget_daily_cents)} of rewards a day.
                </p>
              )}
            </section>

            {/* --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>Guest details</h3>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={form.contact_capture_enabled ?? true}
                  onChange={(e) => set('contact_capture_enabled', e.target.checked)}
                  disabled={!editable}
                />
                <span>
                  <strong>Ask for contact details after they win</strong>
                  <span className="field-hint">
                    Optional and consented — the reward works whether or not they share anything.
                  </span>
                </span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={form.allow_claim_without_play ?? false}
                  onChange={(e) => set('allow_claim_without_play', e.target.checked)}
                  disabled={!editable}
                />
                <span>
                  <strong>Let guests claim without playing</strong>
                  <span className="field-hint">
                    Shows a quiet "prefer not to play?" link that gives your lowest reward. Worth switching on
                    if you'd rather nobody was excluded by reflexes, eyesight or an old phone.
                  </span>
                </span>
              </label>
            </section>

            {/* --------------------------------------------------------- */}
            <section className="panel">
              <div className="panel-head">
                <h3>Your QR</h3>
              </div>
              <p className="engage-hint">
                One code for the whole café. It never changes and never expires — every scan starts a fresh
                game, so a shared link is worth nothing to anyone who isn't here.
              </p>
              <div className="engage-url num">{playUrl}</div>
              <div className="engage-actions">
                <button type="button" className="btn" onClick={() => setShareOpen(true)} disabled={!slug}>
                  <QrCode size={14} strokeWidth={1.5} /> Print table tents
                </button>
                {editable && (
                  <button
                    type="button"
                    className="btn danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Cancel every outstanding code?',
                        message:
                          'Rewards guests have won but not yet used will stop working. Your printed table tents are unaffected — the QR itself never changes.',
                        confirmLabel: 'Cancel codes',
                        danger: true,
                      });
                      if (!ok) return;
                      const res = await invalidate.mutateAsync();
                      toast.success(`${res.voided} code(s) cancelled`);
                    }}
                  >
                    Cancel outstanding codes
                  </button>
                )}
              </div>
            </section>
        </form>
      </QueryState>

      {slug && (
        // The menu share modal, generalised: same QR rendering and the same
        // printable table-tent gallery, pointed at the play URL.
        <PublicMenuShareModal
          slug={slug}
          cafeName={tenant.data?.name}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          url={playUrl}
          heading="Play & win"
          promptText="Scan, play, win a treat."
          eyebrowText="PLAY & WIN"
          storageKey="cafe.qrCardTemplate.play"
        />
      )}
    </PageShell>
  );
}
