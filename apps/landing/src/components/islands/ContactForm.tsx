import { useState } from 'react';
import { REQUEST_ACCESS_ENDPOINT } from '../../data/site';
import { PLANS, formatRs } from '../../data/plans';
import './contact-form.css';

type Status = 'idle' | 'submitting' | 'success' | 'already' | 'error';

// Derived from the single source of truth in data/plans.ts so the dropdown
// can't drift out of sync with the pricing page.
const PLAN_OPTIONS = [
  { value: '', label: 'Not sure yet — help me choose' },
  ...PLANS.map((p) => ({
    value: p.name,
    label: p.yearly != null ? `${p.name} — ${formatRs(p.yearly)}/yr` : `${p.name} — custom`,
  })),
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [form, setForm] = useState({
    name: '',
    cafe_name: '',
    email: '',
    phone: '',
    desired_plan: '',
    message: '',
    company_website: '', // honeypot — real people leave this empty
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((prev) => (prev[k] ? { ...prev, [k]: '' } : prev));
  };

  function validate() {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'Please tell us your name.';
    if (!form.cafe_name.trim()) next.cafe_name = 'What’s your cafe called?';
    if (!EMAIL_RE.test(form.email)) next.email = 'Enter a valid email address.';
    if (!form.phone.trim()) next.phone = 'A phone number lets us reach you fast.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError('');
    if (form.company_website) {
      // Honeypot tripped — pretend success, send nothing.
      setStatus('success');
      return;
    }
    if (!validate()) return;
    setStatus('submitting');
    try {
      const res = await fetch(REQUEST_ACCESS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          cafe_name: form.cafe_name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          desired_plan: form.desired_plan || undefined,
          message: form.message.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 200) {
        setStatus('already');
      } else if (res.status === 429) {
        setStatus('error');
        setServerError('Too many requests just now — please try again in a minute, or email us directly.');
      } else if (res.status === 400) {
        setStatus('error');
        setServerError('Something in the form looked off. Please check your details and try again.');
      } else {
        setStatus('error');
        setServerError('We couldn’t send that. Please try again, or email us directly.');
      }
    } catch {
      setStatus('error');
      setServerError('We couldn’t reach the server. Check your connection, or email us directly.');
    }
  }

  if (status === 'success' || status === 'already') {
    return (
      <div className="cf-done" role="status">
        <div className="cf-done-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </div>
        <h3>{status === 'already' ? 'You’re already on the list' : 'Request received'}</h3>
        <p>
          {status === 'already'
            ? 'We’ve got an earlier request from this email and we’re on it. We’ll be in touch very soon.'
            : 'Thanks — we’ll reach out shortly to set your cafe up. Most cafes are live within a day.'}
        </p>
      </div>
    );
  }

  return (
    <form className="cf" onSubmit={onSubmit} noValidate>
      <div className="cf-row">
        <Field id="name" label="Your name" error={errors.name}>
          <input id="name" name="name" autoComplete="name" value={form.name} onChange={set('name')} aria-invalid={!!errors.name} />
        </Field>
        <Field id="cafe_name" label="Cafe name" error={errors.cafe_name}>
          <input id="cafe_name" name="cafe_name" value={form.cafe_name} onChange={set('cafe_name')} aria-invalid={!!errors.cafe_name} />
        </Field>
      </div>
      <div className="cf-row">
        <Field id="email" label="Email" error={errors.email}>
          <input id="email" name="email" type="email" inputMode="email" autoComplete="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} />
        </Field>
        <Field id="phone" label="Phone" error={errors.phone}>
          <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} aria-invalid={!!errors.phone} />
        </Field>
      </div>
      <Field id="desired_plan" label="Plan you’re eyeing" optional>
        <select id="desired_plan" name="desired_plan" value={form.desired_plan} onChange={set('desired_plan')}>
          {PLAN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>
      <Field id="message" label="Anything we should know?" optional>
        <textarea id="message" name="message" rows={4} value={form.message} onChange={set('message')} placeholder="How you run service, how many staff, what you use today…" />
      </Field>

      {/* Honeypot — visually hidden, off the tab order. */}
      <div className="cf-hp" aria-hidden="true">
        <label htmlFor="company_website">Company website</label>
        <input id="company_website" name="company_website" tabIndex={-1} autoComplete="off" value={form.company_website} onChange={set('company_website')} />
      </div>

      {serverError && <p className="cf-error" role="alert">{serverError}</p>}

      <button type="submit" className="btn btn-primary btn-lg cf-submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : 'Request a demo →'}
      </button>
      <p className="cf-fine">No spam, no card. We only use this to set up your cafe.</p>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  optional,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="cf-field">
      <label htmlFor={id}>
        {label}
        {optional && <span className="cf-optional">optional</span>}
      </label>
      {children}
      {error && <span className="cf-field-error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}
