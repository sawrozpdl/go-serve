import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Coffee, Sparkles, ArrowRight } from 'lucide-react';

import { API_BASE, useAuthConfig, useDevLogin } from '@/lib/api';
import { SteamingCup } from '@/components/SteamingCup';

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

export function Login() {
  const [email, setEmail] = useState('owner@sahan.test');
  const [name, setName] = useState('Sahan Owner');
  const login = useDevLogin();
  const cfg = useAuthConfig();
  const nav = useNavigate();

  // Pick a random starting point so two browsers don't share the same fact.
  const startIdx = useMemo(() => Math.floor(Math.random() * FACTS.length), []);
  const [factIdx, setFactIdx] = useState(startIdx);

  useEffect(() => {
    const t = window.setInterval(() => {
      setFactIdx((i) => (i + 1) % FACTS.length);
    }, 7000);
    return () => window.clearInterval(t);
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login.mutateAsync({ email, name });
      nav('/pick-workspace', { replace: true });
    } catch {
      /* surfaced via login.error */
    }
  };

  const googleEnabled = cfg.data?.google_enabled ?? false;
  const devLoginEnabled = cfg.data?.dev_login_enabled ?? false;
  const nothingEnabled = !cfg.isLoading && !googleEnabled && !devLoginEnabled;

  const fact = FACTS[factIdx] ?? FACTS[0]!;

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

          {login.isError && (
            <div className="banner-error">
              {login.error?.message ?? 'Login failed'}
            </div>
          )}

          {nothingEnabled && (
            <div className="banner-error">
              No login methods configured — set GOOGLE_OAUTH_* or APP_ENV=dev.
            </div>
          )}

          {googleEnabled && (
            <a className="btn-google" href={`${API_BASE}/auth/google`}>
              <GoogleMark />
              <span>continue with Google</span>
              <ArrowRight size={16} strokeWidth={1.6} />
            </a>
          )}

          {googleEnabled && devLoginEnabled && (
            <div className="login-or">
              <span />
              <em>or use dev login</em>
              <span />
            </div>
          )}

          {devLoginEnabled && (
            <form onSubmit={onSubmit} className="login-form">
              <label>email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
              <label>display name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                type="submit"
                className="btn primary"
                disabled={login.isPending}
                style={{ width: '100%' }}
              >
                {login.isPending ? 'signing in…' : 'continue'}
              </button>
            </form>
          )}

          {devLoginEnabled && (
            <p className="login-hint">
              dev mode. seeded accounts:&nbsp;
              <button type="button" className="chip" onClick={() => { setEmail('owner@sahan.test'); setName('Sahan Owner'); }}>
                owner@sahan.test
              </button>
              <button type="button" className="chip" onClick={() => { setEmail('manager@sahan.test'); setName('Sahan Manager'); }}>
                manager@sahan.test
              </button>
              <button type="button" className="chip" onClick={() => { setEmail('owner@brews.test'); setName('Brews Owner'); }}>
                owner@brews.test
              </button>
            </p>
          )}
        </section>
      </div>
    </div>
  );
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
