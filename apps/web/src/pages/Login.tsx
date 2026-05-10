import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useDevLogin } from '@/lib/api';

export function Login() {
  const [email, setEmail] = useState('owner@sahan.test');
  const [name, setName] = useState('Sahan Owner');
  const login = useDevLogin();
  const nav = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login.mutateAsync({ email, name });
      nav('/pick-workspace', { replace: true });
    } catch {
      /* surfaced via login.error */
    }
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>sign in.</h1>
        <p className="sub">cafe-mgmt</p>

        {login.isError && (
          <div className="banner-error">
            {login.error?.message ?? 'Login failed'}
          </div>
        )}

        <form onSubmit={onSubmit}>
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
          <label>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn primary" disabled={login.isPending} style={{ width: '100%' }}>
            {login.isPending ? 'Signing in…' : 'Continue'}
          </button>
        </form>

        <p className="hint">
          Dev login. Pick any email — for seeded users try <code>owner@sahan.test</code> or{' '}
          <code>owner@brews.test</code>.
        </p>
      </div>
    </div>
  );
}
