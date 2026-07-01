/**
 * useTheme — the hook every component uses to read colors/spacing/typography.
 * Throws if used outside a ThemeProvider so misuse fails loudly in dev/tests.
 */
import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from './ThemeProvider';
import type { Theme } from './buildTheme';

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}
