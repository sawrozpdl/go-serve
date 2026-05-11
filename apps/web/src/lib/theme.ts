// Theme preference (light/dark), persisted to localStorage. Applied as a
// `data-theme` attribute on <html> so CSS in tokens.css can flip the ink
// scale without re-rendering React. Dark is the default — apps that
// render before hydration paint in the historical dark look.

import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'cafe-theme';
const DEFAULT_THEME: Theme = 'dark';

function read(): Theme {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME;
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : DEFAULT_THEME;
}

function write(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* Safari private mode etc. — swallow. */
  }
}

// Apply the persisted (or default) theme to <html>. Call once at startup,
// before React renders, so the first paint matches the user's choice.
export function initTheme() {
  write(read());
}

// External subscribers so React components can react to theme flips
// triggered elsewhere (e.g. a future "follow system" toggle).
const listeners = new Set<() => void>();

export function setTheme(theme: Theme) {
  write(theme);
  listeners.forEach((fn) => fn());
}

export function getTheme(): Theme {
  return read();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    read,
    () => DEFAULT_THEME,
  );
  return [theme, setTheme];
}
