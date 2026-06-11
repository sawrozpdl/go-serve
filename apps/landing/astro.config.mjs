// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project-site defaults. When a custom domain lands, set
// SITE='https://<domain>' and BASE='/' in the deploy workflow — no code edits.
const SITE = process.env.SITE ?? 'https://sawrozpdl.github.io';
const BASE = process.env.BASE ?? '/goserve-landing';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [react(), sitemap()],
});
