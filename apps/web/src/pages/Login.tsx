import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Coffee, Sparkles, ArrowRight, Mail } from 'lucide-react';

import {
  API_BASE,
  useAuthConfig,
  useDevLogin,
  useRequestOTP,
  useVerifyOTP,
  type ApiError,
} from '@/lib/api';
import { SteamingCup } from '@/components/SteamingCup';
import { OTPInput } from '@/components/OTPInput';
import { OTPCountdown } from '@/components/OTPCountdown';
import { toast } from '@/lib/toast';

// Rotating slate of fun cafe-trivia + barista wisdom. Picked at random on
// mount so each visit feels a little different, then auto-rotated every 7s
// so a user staring at the screen mid-login still gets something new.
const FACTS: { tag: string; text: string }[] = [
  { tag: 'fun fact', text: 'The word "espresso" means "pressed out" in Italian — the brew is literally squeezed through the grounds.' },
  { tag: 'fun fact', text: 'A single coffee tree produces only about 1 kg of roasted beans per year. Your morning cup is rare work.' },
  { tag: 'history', text: 'The first cafe in the world opened in Constantinople in 1554. Customers paid extra to sit near the windows.' },
  { tag: 'science', text: 'Caffeine peaks in your blood roughly 45 minutes after the first sip. Plan that afternoon meeting accordingly.' },
  { tag: 'barista', text: 'Crema thickness on an espresso is a quick health-check on your beans — older roasts crema thin and pale.' },
  { tag: 'taste', text: 'A perfectly steamed milk should hum, not screech. If you can hear it across the room, drop the wand.' },
  { tag: 'fun fact', text: 'Beethoven counted exactly 60 beans for each cup of coffee. Eight cups a day. Every day.' },
  { tag: 'history', text: 'Cappuccinos got their name from Capuchin friars — the milk-foam color matches their hooded robes.' },
  { tag: 'business', text: 'Cafes that name regulars in the queue get a 22% repeat-visit lift. The data is brutal: small talk pays.' },
  { tag: 'taste', text: 'Cold-brew coffee has ~70% less acidity than hot-brewed. Good for sensitive stomachs, bad for dramatic flavor.' },
  { tag: 'fun fact', text: 'Finland drinks more coffee per capita than any other country. About 12 kg per person per year.' },
  { tag: 'science', text: 'A 1°C swing in water temperature can shift extraction by ~5%. Espresso machines obsess over thermal stability for a reason.' },
];

type OTPStep = 'email' | 'code';

// Temporarily disabled while we sort out prod email delivery (see ses_prod_email
// notes) — shows as a "coming soon" placeholder instead of a working input.
const OTP_COMING_SOON = true;

export function Login() {
  const cfg = useAuthConfig();
  const nav = useNavigate();

  // Dev-login state (preserved as a third option).
  const [devEmail, setDevEmail] = useState('owner@sahan.test');
  const [devName, setDevName] = useState('Sahan Owner');
  const devLogin = useDevLogin();

  // OTP state.
  const [otpStep, setOtpStep] = useState<OTPStep>('email');
  const [otpEmail, setOtpEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [resendSeconds, setResendSeconds] = useState(0);
  // When the server rate-limits a code request (429), we block the send button
  // and tick this down so the user can see exactly when they may retry.
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const requestOTP = useRequestOTP();
  const verifyOTP = useVerifyOTP();

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const t = window.setInterval(() => {
      setCooldownSeconds((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(t);
  }, [cooldownSeconds]);

  // Pick a random starting fact so two browsers don't share the same one.
  const startIdx = useMemo(() => Math.floor(Math.random() * FACTS.length), []);
  const [factIdx, setFactIdx] = useState(startIdx);
  useEffect(() => {
    const t = window.setInterval(() => {
      setFactIdx((i) => (i + 1) % FACTS.length);
    }, 7000);
    return () => window.clearInterval(t);
  }, []);

  const googleEnabled = cfg.data?.google_enabled ?? false;
  const devLoginEnabled = cfg.data?.dev_login_enabled ?? false;
  const emailOtpEnabled = cfg.data?.email_otp_enabled ?? false;
  const nothingEnabled =
    !cfg.isLoading && !googleEnabled && !devLoginEnabled && !emailOtpEnabled;

  const fact = FACTS[factIdx] ?? FACTS[0]!;

  const onDevSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await devLogin.mutateAsync({ email: devEmail, name: devName });
      nav('/pick-workspace', { replace: true });
    } catch {
      /* surfaced via devLogin.error */
    }
  };

  const sendCode = async (email: string) => {
    try {
      const res = await requestOTP.mutateAsync({ email });
      setResendSeconds(res.resend_in_seconds);
      setCooldownSeconds(0);
      setOtpStep('code');
      setOtpCode('');
      toast.success('Code sent — check your inbox.');
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 429) {
        // Rate-limited / cooldown: the request FAILED — no new code was sent.
        // Don't advance to the code step (that wrongly reads as "sent"); instead
        // tell the user when they can retry and block the button until then.
        const retry = e.retry_after_seconds && e.retry_after_seconds > 0 ? e.retry_after_seconds : 60;
        setCooldownSeconds(retry);
        setResendSeconds(retry); // also gates the resend timer if we're on the code step
        toast.error(`Too many requests — try again in ${formatRetry(retry)}.`);
      } else {
        toast.error(e.message ?? 'Could not send code. Try again.');
      }
    }
  };

  const onEmailSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!otpEmail || cooldownSeconds > 0) return;
    void sendCode(otpEmail);
  };

  const submitCode = async (code: string) => {
    if (code.length < 6) return;
    try {
      await verifyOTP.mutateAsync({ email: otpEmail, code });
      nav('/pick-workspace', { replace: true });
    } catch (err) {
      const e = err as { code?: string; message?: string; attempts_remaining?: number };
      if (typeof e.attempts_remaining === 'number') {
        if (e.attempts_remaining <= 0) {
          toast.error('Too many wrong attempts. Request a new code.');
          setOtpStep('email');
          setOtpCode('');
        } else {
          toast.error(`That code isn't right. ${e.attempts_remaining} tries left.`);
          setOtpCode('');
        }
      } else {
        toast.error(e.message ?? 'Code is invalid or expired. Request a new one.');
        setOtpStep('email');
        setOtpCode('');
      }
    }
  };

  const onCodeSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitCode(otpCode);
  };

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
        {/* Left rail — fun zone */}
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

          <div className="login-quote-card" key={factIdx}>
            <div className="login-quote-tag">
              <Sparkles size={11} strokeWidth={1.6} />
              {fact.tag}
            </div>
            <p className="login-quote-text">{fact.text}</p>
            <div className="login-quote-dots" aria-hidden="true">
              {FACTS.map((_, i) => (
                <span
                  key={i}
                  className={'dot' + (i === factIdx ? ' on' : '')}
                  onClick={() => setFactIdx(i)}
                />
              ))}
            </div>
          </div>

          <div className="login-stats">
            <div>
              <div className="num">{new Date().getHours() < 12 ? '☕' : new Date().getHours() < 17 ? '🥐' : '🍵'}</div>
              <div className="lbl">{greeting()}</div>
            </div>
            <div>
              <div className="num">{FACTS.length}</div>
              <div className="lbl">facts inside</div>
            </div>
            <div>
              <div className="num">∞</div>
              <div className="lbl">tabs to open</div>
            </div>
          </div>
        </aside>

        {/* Right rail — sign-in */}
        <section className="login-card-v2">
          <header>
            <h1>welcome back.</h1>
            <p className="sub">sign in to run your floor.</p>
          </header>

          {nothingEnabled && (
            <div className="banner-error">
              No login methods configured — set GOOGLE_OAUTH_*, MAIL_*, or APP_ENV=dev.
            </div>
          )}

          {googleEnabled && (
            <a className="btn-google" href={`${API_BASE}/auth/google`}>
              <GoogleMark />
              <span>continue with Google</span>
              <ArrowRight size={16} strokeWidth={1.6} />
            </a>
          )}

          {emailOtpEnabled && googleEnabled && (
            <div className="login-or">
              <span />
              <em>or</em>
              <span />
            </div>
          )}

          {emailOtpEnabled && OTP_COMING_SOON && (
            <div className="login-form">
              <label>email</label>
              <input type="email" placeholder="you@example.com" disabled />
              <button type="button" className="btn primary" disabled style={{ width: '100%' }}>
                <Mail size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
                coming soon
              </button>
            </div>
          )}

          {emailOtpEnabled && !OTP_COMING_SOON && otpStep === 'email' && (
            <form onSubmit={onEmailSubmit} className="login-form">
              <label htmlFor="otp-email">email</label>
              <input
                id="otp-email"
                type="email"
                value={otpEmail}
                onChange={(e) => setOtpEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
              <button
                type="submit"
                className="btn primary"
                disabled={requestOTP.isPending || !otpEmail || cooldownSeconds > 0}
                style={{ width: '100%' }}
              >
                <Mail size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
                {cooldownSeconds > 0
                  ? `try again in ${formatRetry(cooldownSeconds)}`
                  : requestOTP.isPending
                    ? 'sending…'
                    : 'send me a code'}
              </button>
            </form>
          )}

          {emailOtpEnabled && !OTP_COMING_SOON && otpStep === 'code' && (
            <form onSubmit={onCodeSubmit} className="login-form">
              <div className="otp-meta">
                <span>sent to {otpEmail}</span>
                <button
                  type="button"
                  className="change-email"
                  onClick={() => {
                    setOtpStep('email');
                    setOtpCode('');
                  }}
                >
                  ← change email
                </button>
              </div>
              <label htmlFor="otp-code">enter 6-digit code</label>
              <OTPInput
                value={otpCode}
                onChange={setOtpCode}
                length={6}
                disabled={verifyOTP.isPending}
                autoFocus
                onComplete={(code) => void submitCode(code)}
              />
              <button
                type="submit"
                className="btn primary"
                disabled={verifyOTP.isPending || otpCode.length < 6}
                style={{ width: '100%' }}
              >
                {verifyOTP.isPending ? 'verifying…' : 'verify'}
              </button>
              <div className="otp-footer">
                <OTPCountdown
                  seconds={resendSeconds}
                  onResend={() => void sendCode(otpEmail)}
                  disabled={requestOTP.isPending}
                />
              </div>
            </form>
          )}

          {emailOtpEnabled && devLoginEnabled && (
            <div className="login-or">
              <span />
              <em>or use dev login</em>
              <span />
            </div>
          )}

          {!emailOtpEnabled && googleEnabled && devLoginEnabled && (
            <div className="login-or">
              <span />
              <em>or use dev login</em>
              <span />
            </div>
          )}

          {devLoginEnabled && (
            <>
              {devLogin.isError && (
                <div className="banner-error">
                  {devLogin.error?.message ?? 'Login failed'}
                </div>
              )}
              <form onSubmit={onDevSubmit} className="login-form">
                <label>email</label>
                <input
                  type="email"
                  value={devEmail}
                  onChange={(e) => setDevEmail(e.target.value)}
                  required
                />
                <label>display name</label>
                <input
                  type="text"
                  value={devName}
                  onChange={(e) => setDevName(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn primary"
                  disabled={devLogin.isPending}
                  style={{ width: '100%' }}
                >
                  {devLogin.isPending ? 'signing in…' : 'continue'}
                </button>
              </form>

              <p className="login-hint">
                dev mode. seeded accounts:&nbsp;
                <button type="button" className="chip" onClick={() => { setDevEmail('owner@sahan.test'); setDevName('Sahan Owner'); }}>
                  owner@sahan.test
                </button>
                <button type="button" className="chip" onClick={() => { setDevEmail('manager@sahan.test'); setDevName('Sahan Manager'); }}>
                  manager@sahan.test
                </button>
                <button type="button" className="chip" onClick={() => { setDevEmail('owner@brews.test'); setDevName('Brews Owner'); }}>
                  owner@brews.test
                </button>
              </p>
            </>
          )}

          <p className="login-hint" style={{ marginTop: 'var(--space-4)' }}>
            New here? <Link to="/request-access" style={{ color: 'var(--amber-fg)' }}>Request access</Link> and we'll set up your cafe.
          </p>
        </section>
      </div>
    </div>
  );
}

// Compact human retry hint: "45s" under a minute, "1m 05s" above it.
function formatRetry(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}m ${ss}s`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'late shift';
  if (h < 12) return 'good morning';
  if (h < 17) return 'good afternoon';
  if (h < 21) return 'good evening';
  return 'late shift';
}

function GoogleMark() {
  // 4-color G mark, kept inline so the button has no network dependency.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.77c-.99.66-2.25 1.05-3.72 1.05-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}
