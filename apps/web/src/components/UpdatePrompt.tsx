/* UpdatePrompt
 *
 * Service-worker update flow. The SW registers with `prompt` mode (never
 * auto-reload a POS mid-order); when a new build is waiting this surfaces a
 * dismissible bar with a Reload action. Also checks for updates hourly and
 * whenever the tab becomes visible, so a tablet that stays open for days
 * still discovers deploys.
 */

import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      window.setInterval(() => void registration.update(), CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update();
      });
    },
  });

  // ESC dismisses, matching the app's modal conventions.
  useEffect(() => {
    if (!needRefresh) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNeedRefresh(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [needRefresh, setNeedRefresh]);

  if (!needRefresh) return null;

  return (
    <div className="update-bar" role="status">
      <span>A new version of GoServe is ready.</span>
      <button type="button" className="btn small primary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button type="button" className="btn small" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
