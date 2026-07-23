// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// Forward-looking defaults point at the intended production domain
// (goserve.com.np, served at the root). The GitHub Pages mirror deploy in
// .github/workflows/deploy-landing.yml overrides SITE/BASE to its project
// sub-path so the preview keeps working until the custom domain is live.
const SITE = process.env.SITE || 'https://goserve.com.np';
const BASE = process.env.BASE || '/';

// Rewrite root-relative links inside markdown (e.g. /pricing, /blog/slug)
// so they respect the deploy base. Self-contained hast walk — no extra dep.
function rehypeBaseLinks() {
  const prefix = BASE.replace(/\/+$/, '');
  if (!prefix) return () => {};
  /** @param {any} node */
  const walk = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && node.properties) {
      const href = node.properties.href;
      if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')) {
        node.properties.href = prefix + href;
      }
    }
    (node.children || []).forEach(walk);
  };
  return (/** @type {any} */ tree) => walk(tree);
}

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [react(), sitemap()],
  markdown: {
    rehypePlugins: [rehypeBaseLinks],
  },
});
