import { Sun, Moon } from 'lucide-react';

import { useTheme, type Theme } from '@/lib/theme';

/**
 * Animated two-state theme toggle. Renders as a pill with a sliding
 * amber thumb under the active mode, the two icons stay visible so the
 * affordance reads at a glance. The thumb position is driven entirely
 * by CSS — flipping the data-attr re-triggers the transition.
 *
 * Sized for a comfortable thumb-tap on mobile (44px hit area) without
 * looking chunky on desktop.
 */
export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useTheme();

  const set = (next: Theme) => {
    if (next !== theme) setTheme(next);
  };

  return (
    <div
      className={`theme-switch${compact ? ' theme-switch--compact' : ''}`}
      role="radiogroup"
      aria-label="Color theme"
      data-theme={theme}
    >
      <span className="theme-switch-thumb" aria-hidden="true" />
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'light'}
        className={`theme-switch-opt${theme === 'light' ? ' on' : ''}`}
        onClick={() => set('light')}
        title="Light mode"
      >
        <Sun size={14} strokeWidth={1.8} />
        {!compact && <span>Light</span>}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'dark'}
        className={`theme-switch-opt${theme === 'dark' ? ' on' : ''}`}
        onClick={() => set('dark')}
        title="Dark mode"
      >
        <Moon size={14} strokeWidth={1.8} />
        {!compact && <span>Dark</span>}
      </button>
    </div>
  );
}
