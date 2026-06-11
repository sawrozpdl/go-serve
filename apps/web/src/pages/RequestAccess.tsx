import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Send,
  Coffee,
  Receipt,
  UtensilsCrossed,
  Layers,
  TrendingUp,
} from 'lucide-react';

import { usePublicPlans, useCreateTenantRequest } from '@/lib/public';
import { SteamingCup } from '@/components/SteamingCup';

// What a new cafe gets — shown on the left rail so "request access" reads as an
// invitation, not a form. Kept short and concrete; each maps to a real surface.
const PERKS: { icon: typeof Receipt; title: string; sub: string }[] = [
  { icon: Receipt, title: 'Lightning POS', sub: 'orders · kitchen tickets' },
  { icon: UtensilsCrossed, title: 'Live floor', sub: 'tables · open tabs' },
  { icon: Layers, title: 'Inventory', sub: 'auto-deduct on close' },
  { icon: TrendingUp, title: 'Reports', sub: 'profit · shifts · history' },
];

export default function RequestAccess() {
  const plans = usePublicPlans();
  const submit = useCreateTenantRequest();

  const [form, setForm] = useState({
    name: '',
    cafe_name: '',
    email: '',
    phone: '',
    desired_plan: '',
    message: '',
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.cafe_name.trim() || !form.email.trim()) return;
    try {
      await submit.mutateAsync(form);
    } catch {
      /* surfaced via submit.error */
    }
  };

  const done = submit.isSuccess;
  const canSubmit = form.name.trim() && form.cafe_name.trim() && form.email.trim();

  return (
    <div className="login-stage">
      {/* Drifting beans in the background — slow, decorative, behind everything. */}
      <div className="login-beans" aria-hidden="true">
        {Array.from({ length: 14 }).map((_, i) => (
          <span key={i} className={`bean bean-${i}`}>
            <Coffee size={18} strokeWidth={1.4} />
          </span>
        ))}
      </div>

      <div className="login-grid">
        {/* Left rail — the invitation */}
        <aside className="login-rail">
          <div className="login-rail-top">
            <div className="login-mark">
              <SteamingCup size={44} />
            </div>
            <div>
              <div className="login-rail-name">GoServe</div>
              <div className="login-rail-sub">point of sale · inventory · floor</div>
            </div>
          </div>

          <div>
            <p className="ra-pitch">
              Everything you need to run your cafe — set up in minutes, no card required.
            </p>
            <div className="ra-perks">
              {PERKS.map((p) => {
                const Icon = p.icon;
                return (
                  <div className="ra-perk" key={p.title}>
                    <div className="ra-perk-ico">
                      <Icon size={17} strokeWidth={1.6} />
                    </div>
                    <div className="ra-perk-tx">
                      <b>{p.title}</b>
                      <span>{p.sub}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="login-stats">
            <div>
              <div className="num">5 min</div>
              <div className="lbl">to set up</div>
            </div>
            <div>
              <div className="num">₨0</div>
              <div className="lbl">to start</div>
            </div>
            <div>
              <div className="num">∞</div>
              <div className="lbl">tabs to open</div>
            </div>
          </div>
        </aside>

        {/* Right pane — the form (or the thank-you) */}
        <section className="login-card-v2">
          {done ? (
            <div className="ra-done">
              <div className="ra-done-badge">
                <CheckCircle2 size={30} strokeWidth={1.5} />
              </div>
              <h1>You're on the list</h1>
              <p className="sub">
                {submit.data?.status === 'already_pending'
                  ? "You've already got a request in — we'll be in touch shortly."
                  : "Thanks! We'll review and reach out to set up your cafe."}
              </p>
              <Link to="/login" className="btn ra-back">
                <ArrowLeft size={14} strokeWidth={1.6} /> back to sign in
              </Link>
            </div>
          ) : (
            <>
              <header>
                <h1>Request access</h1>
                <p className="sub">Tell us about your cafe and we'll get you set up.</p>
              </header>

              {submit.isError && (
                <div className="banner-error">
                  {submit.error?.message ?? 'Could not submit your request'}
                </div>
              )}

              <form onSubmit={onSubmit} className="ra-form">
                <div className="ra-row">
                  <div className="ra-field">
                    <label htmlFor="ra-name">your name</label>
                    <input id="ra-name" type="text" value={form.name} onChange={set('name')} required autoFocus />
                  </div>
                  <div className="ra-field">
                    <label htmlFor="ra-cafe">cafe name</label>
                    <input id="ra-cafe" type="text" value={form.cafe_name} onChange={set('cafe_name')} placeholder="e.g. Sahan Cafe" required />
                  </div>
                </div>

                <div className="ra-row">
                  <div className="ra-field">
                    <label htmlFor="ra-email">email</label>
                    <input id="ra-email" type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" autoComplete="email" required />
                  </div>
                  <div className="ra-field">
                    <label htmlFor="ra-phone">
                      phone <span className="ra-opt">optional</span>
                    </label>
                    <input id="ra-phone" type="tel" value={form.phone} onChange={set('phone')} placeholder="+977 …" />
                  </div>
                </div>

                <div className="ra-field">
                  <label htmlFor="ra-plan">
                    plan you're interested in <span className="ra-opt">optional</span>
                  </label>
                  <select id="ra-plan" value={form.desired_plan} onChange={set('desired_plan')}>
                    <option value="">No preference — help me pick</option>
                    {(plans.data ?? []).map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                        {p.member_limit ? ` — up to ${p.member_limit} people` : ''}
                        {p.price_copy ? ` (${p.price_copy})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ra-field">
                  <label htmlFor="ra-msg">
                    anything else? <span className="ra-opt">optional</span>
                  </label>
                  <textarea
                    id="ra-msg"
                    value={form.message}
                    onChange={set('message')}
                    rows={4}
                    maxLength={2000}
                    placeholder="Tell us about your menu, team size, or what you're hoping to fix."
                  />
                </div>

                <button type="submit" className="btn primary ra-submit" disabled={submit.isPending || !canSubmit}>
                  <Send size={14} strokeWidth={1.8} />
                  {submit.isPending ? 'sending…' : 'submit request'}
                </button>
              </form>

              <p className="login-hint ra-foot">
                Already have an account?{' '}
                <Link to="/login" style={{ color: 'var(--amber-fg)' }}>
                  Sign in
                </Link>
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
