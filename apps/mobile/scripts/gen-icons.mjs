/**
 * gen-icons.mjs — regenerate the GoServe app-icon set from the brand mark.
 *
 * The mark is the "Docket" steaming cup (ported from
 * apps/web/src/components/SteamingCup.tsx) in brand amber on a carbon field —
 * the same #0f0e0b the splash + adaptive background use (app.config.ts).
 *
 * Vector in, PNG out: we compose an SVG per target and let sharp rasterize it,
 * so the whole set stays crisp and consistent and is trivially re-tweaked.
 *
 * Run:  pnpm --dir apps/mobile gen:icons   (or: node scripts/gen-icons.mjs)
 * Dep:  sharp (devDependency). Icons are committed; only re-run on a brand change.
 */
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const CARBON = '#0f0e0b'; // Docket ink 1000 (dark) — splash/adaptive bg
const AMBER = '#ffa319'; // brand primary, kept for stamps/marks
const WHITE = '#ffffff'; // Android themed-icon monochrome layer (system tints it)

const OUT = new URL('../assets/images/', import.meta.url);

/** The cup mark in a 48×48 box (matches SteamingCup's viewBox). */
function cupMarkup(ink, mono) {
  return `
    <g stroke="${ink}" stroke-linecap="round" fill="none" stroke-width="1.8">
      <path d="M16 14 C 18 11, 14 9, 16 6" />
      <path d="M24 13 C 26 10, 22 8, 24 5" />
      <path d="M32 14 C 34 11, 30 9, 32 6" />
    </g>
    <ellipse cx="24" cy="40" rx="16" ry="2.4" fill="${ink}" opacity="${mono ? 1 : 0.22}" />
    <path d="M10 18 H34 C34 30 30 38 22 38 C14 38 10 30 10 18 Z" fill="${ink}" />
    <path d="M34 22 C 40 22, 40 32, 34 32" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round" />
  `;
}

/** Compose a full square SVG: optional bg fill + a centered, scaled cup. */
function composeSvg({ size, bg, ink, scale, mono, bgOnly }) {
  const side = size * scale;
  const off = (size - side) / 2;
  const bgRect = bg ? `<rect width="${size}" height="${size}" fill="${bg}" />` : '';
  const mark = bgOnly
    ? ''
    : `<svg x="${off}" y="${off}" width="${side}" height="${side}" viewBox="0 0 48 48">${cupMarkup(ink, mono)}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bgRect}${mark}</svg>`;
}

// scale = fraction of the canvas the artwork spans. Adaptive layers keep the
// mark well inside the ~66% safe zone so masking never clips it.
const TARGETS = [
  // Cross-platform icon (iOS + fallback): full-bleed carbon, OS rounds corners.
  { file: 'icon.png', size: 1024, bg: CARBON, ink: AMBER, scale: 0.6 },
  // Android adaptive layers.
  { file: 'android-icon-background.png', size: 1024, bg: CARBON, bgOnly: true },
  { file: 'android-icon-foreground.png', size: 1024, bg: null, ink: AMBER, scale: 0.56 },
  { file: 'android-icon-monochrome.png', size: 1024, bg: null, ink: WHITE, scale: 0.56, mono: true },
  // Splash mark (shown at imageWidth 76 on a carbon field → transparent bg).
  { file: 'splash-icon.png', size: 512, bg: null, ink: AMBER, scale: 0.78 },
  // Web favicon.
  { file: 'favicon.png', size: 64, bg: CARBON, ink: AMBER, scale: 0.66 },
];

for (const t of TARGETS) {
  const svg = composeSvg(t);
  const dest = fileURLToPath(new URL(t.file, OUT));
  await sharp(Buffer.from(svg)).png().toFile(dest);
  console.log(`✓ ${t.file}  (${t.size}×${t.size})`);
}
console.log('\nDone. Icons regenerated from the brand mark.');
