import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PlayApp } from './PlayApp';
import '../styles/play.css';

// =========================================================================
// The guest play entry.
//
// Compare with main.tsx next door, and note everything that ISN'T here: no
// router, no TanStack Query, no query persister, no idb-keyval, no auth store,
// no theme init, no admin.css, no design tokens, no lucide. That absence is the
// feature — see the note on build.rollupOptions.input in vite.config.ts.
//
// play.css is imported HERE rather than in a component so it lands in this
// entry's own stylesheet and can never be pulled into the admin bundle. Same
// discipline as menu-public.css.
//
// If you are adding an import to anything under src/play/, check the
// no-restricted-imports rule in eslint.config.js first — it exists because one
// careless '@/lib/api' silently restores a 1.1MB critical path that nothing
// else in CI would notice.
// =========================================================================

const root = document.getElementById('play-root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PlayApp />
    </StrictMode>,
  );
}
