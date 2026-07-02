/**
 * ThemeProvider — resolves the active Theme from (a) the tenant branding, (b)
 * the OS color scheme, and (c) a user override persisted in MMKV, then exposes
 * it via context. buildTheme() does the pure resolution; this wrapper only
 * holds the reactive state.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import type { ColorScheme, TenantBranding } from '@cafe-mgmt/design-tokens';
import { buildTheme, type Theme } from './buildTheme';
import { getString, KV, setString } from '../lib/kv';

/** User's explicit override, or 'system' to follow the OS. */
export type ThemePreference = ColorScheme | 'system';

export type ThemeContextValue = {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  const raw = getString(KV.themeOverride);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export type ThemeProviderProps = {
  children: ReactNode;
  /** Tenant branding to theme with; null uses house defaults. */
  branding?: TenantBranding | null;
  /** Test seam: force an initial preference instead of reading MMKV. */
  initialPreference?: ThemePreference;
};

export function ThemeProvider({ children, branding = null, initialPreference }: ThemeProviderProps) {
  const osScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(
    initialPreference ?? readPreference,
  );

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    setString(KV.themeOverride, p);
  }, []);

  const scheme: ColorScheme =
    preference === 'system' ? (osScheme === 'light' ? 'light' : 'dark') : preference;

  const theme = useMemo(() => buildTheme(branding, scheme), [branding, scheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, preference, setPreference }),
    [theme, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * ThemeScope — re-provide the theme with a pinned scheme, regardless of the
 * user's preference. The KDS uses this to force carbon (dark): the kitchen is
 * glanced at from meters away, so it's always the dark board. Branding stays
 * null on mobile, so a fresh buildTheme is all that's needed; preference /
 * setPreference pass through so anything below can still read/toggle them.
 */
export function ThemeScope({ scheme, children }: { scheme: ColorScheme; children: ReactNode }) {
  const parent = useContext(ThemeContext);
  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: buildTheme(null, scheme),
      preference: parent?.preference ?? 'system',
      setPreference: parent?.setPreference ?? (() => {}),
    }),
    [parent, scheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
