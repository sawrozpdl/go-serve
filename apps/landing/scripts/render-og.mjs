/* One-shot rasterizer: og-source.svg -> public/og.png (1200x630).
 * Uses sharp, which Astro already brings into the workspace.
 * Run from apps/landing: node scripts/render-og.mjs */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(require_astro());
const sharp = require('sharp');

function require_astro() {
  // Resolve sharp through astro's own dependency tree (pnpm-strict safe).
  const r = createRequire(path.join(here, '..', 'package.json'));
  return r.resolve('astro/package.json');
}

await sharp(path.join(here, '..', 'og-source.svg'), { density: 96 })
  .resize(1200, 630)
  .png()
  .toFile(path.join(here, '..', 'public', 'og.png'));

console.log('wrote public/og.png');
