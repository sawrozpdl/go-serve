import { useEffect } from 'react';
import { Link } from 'react-router-dom';

import { SteamingCup } from '@/components/SteamingCup';

/** Branded 404 — replaces the old silent redirect-to-root so a mistyped URL
 *  tells the user what happened instead of quietly landing them elsewhere. */
export function NotFound() {
  useEffect(() => {
    const prev = document.title;
    document.title = 'Page not found · GoServe';
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="login-shell">
      <div className="login-card" role="alert">
        <div className="empty-illu compact">
          <div className="empty-illu-art" aria-hidden="true">
            <SteamingCup size={56} hero />
          </div>
          <div className="empty-illu-title">Page not found</div>
          <div className="empty-illu-hint">
            That link doesn't go anywhere — it may have moved, or the address has a typo.
          </div>
          <div className="empty-illu-cta">
            <Link className="btn primary" to="/">
              Back to the app
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
