import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Send } from 'lucide-react';

import { usePublicPlans, useCreateTenantRequest } from '@/lib/public';

// Public, unauthenticated onboarding. A prospective cafe tells us who they are
// and which plan they want; the request lands in the super-admin queue and we
// provision them. Intentionally uses only the public data layer (no authed
// client) so it stays in the public bundle.
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

  return (
    <div className="login-shell">
      <div className="login-card-v2" style={{ maxWidth: 460 }}>
        {done ? (
          <header>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={22} strokeWidth={1.6} color="var(--lime-fg, var(--amber-fg))" />
              Request received
            </h1>
            <p className="sub">
              {submit.data?.status === 'already_pending'
                ? "You've already got a request in — we'll be in touch shortly."
                : "Thanks! We'll review and reach out to set up your cafe."}
            </p>
            <Link to="/login" className="btn" style={{ marginTop: 16, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <ArrowLeft size={14} strokeWidth={1.6} /> back to sign in
            </Link>
          </header>
        ) : (
          <>
            <header>
              <h1>Request access</h1>
              <p className="sub">Tell us about your cafe and we'll get you set up.</p>
            </header>

            {submit.isError && (
              <div className="banner-error">{submit.error?.message ?? 'Could not submit your request'}</div>
            )}

            <form onSubmit={onSubmit} className="login-form">
              <label htmlFor="ra-name">your name</label>
              <input id="ra-name" type="text" value={form.name} onChange={set('name')} required autoFocus />

              <label htmlFor="ra-cafe">cafe name</label>
              <input id="ra-cafe" type="text" value={form.cafe_name} onChange={set('cafe_name')} placeholder="e.g. Sahan Cafe" required />

              <label htmlFor="ra-email">email</label>
              <input id="ra-email" type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" autoComplete="email" required />

              <label htmlFor="ra-phone">phone</label>
              <input id="ra-phone" type="tel" value={form.phone} onChange={set('phone')} placeholder="+977 …" />

              <label htmlFor="ra-plan">plan you're interested in</label>
              <select id="ra-plan" value={form.desired_plan} onChange={set('desired_plan')}>
                <option value="">No preference</option>
                {(plans.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                    {p.member_limit ? ` — up to ${p.member_limit} people` : ''}
                    {p.price_copy ? ` (${p.price_copy})` : ''}
                  </option>
                ))}
              </select>

              <label htmlFor="ra-msg">anything else? (optional)</label>
              <textarea id="ra-msg" value={form.message} onChange={set('message')} rows={3} maxLength={2000} />

              <button
                type="submit"
                className="btn primary"
                disabled={submit.isPending || !form.name.trim() || !form.cafe_name.trim() || !form.email.trim()}
                style={{ width: '100%' }}
              >
                <Send size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
                {submit.isPending ? 'sending…' : 'submit request'}
              </button>
            </form>

            <p className="login-hint" style={{ marginTop: 16 }}>
              Already have an account? <Link to="/login" style={{ color: 'var(--amber-fg)' }}>Sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
