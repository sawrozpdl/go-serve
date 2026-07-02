import {
  MOODS,
  MOODS_V2,
  BRAND,
  INK_SCALE_DARK,
  INK_SCALE_LIGHT,
  TOUCH,
  TYPE_STYLES,
  stampToneFgFor,
} from '@cafe-mgmt/design-tokens';
import type { StampTone, TenantBranding, TypographyKey } from '@cafe-mgmt/design-tokens';
import { buildTheme, TYPOGRAPHY_KEYS, hexToRgba, mixHex } from '../buildTheme';

const HEX6 = /^#[0-9a-f]{6}$/;

describe('buildTheme', () => {
  describe('color scheme resolution', () => {
    it('uses the dark ink scale for the dark scheme', () => {
      const t = buildTheme(null, 'dark');
      expect(t.scheme).toBe('dark');
      expect(t.colors.ink).toEqual(INK_SCALE_DARK);
      expect(t.colors.bg).toBe(INK_SCALE_DARK[1000]);
      expect(t.colors.surface).toBe(INK_SCALE_DARK[900]);
      expect(t.colors.card).toBe(INK_SCALE_DARK[800]);
      expect(t.colors.text).toBe(INK_SCALE_DARK[100]);
    });

    it('uses the light ink scale for the light scheme', () => {
      const t = buildTheme(null, 'light');
      expect(t.scheme).toBe('light');
      expect(t.colors.ink).toEqual(INK_SCALE_LIGHT);
      expect(t.colors.bg).toBe(INK_SCALE_LIGHT[1000]);
    });

    it('pins onBrand dark in both schemes', () => {
      expect(buildTheme(null, 'dark').colors.onBrand).toBe(BRAND.onBrand);
      expect(buildTheme(null, 'light').colors.onBrand).toBe(BRAND.onBrand);
    });
  });

  describe('brand resolution', () => {
    it('falls back to house amber/lime with no branding', () => {
      const t = buildTheme(null, 'dark');
      expect(t.colors.primary).toBe(BRAND.amber500);
      expect(t.colors.accent).toBe(BRAND.lime500);
      expect(t.mood).toBeNull();
    });

    it('honors explicit brand hex overrides above everything', () => {
      const branding: TenantBranding = {
        brandPrimary: '#123456',
        brandAccent: '#654321',
        mood: 'rose-bistro',
      };
      const t = buildTheme(branding, 'dark');
      expect(t.colors.primary).toBe('#123456');
      expect(t.colors.accent).toBe('#654321');
      // mood label still reported for the picker
      expect(t.mood).toBe('rose-bistro');
    });

    it('derives colors from the mood preset when no explicit hex', () => {
      const rose = MOODS.find((m) => m.key === 'rose-bistro')!;
      const t = buildTheme({ mood: 'rose-bistro' }, 'dark');
      expect(t.colors.primary).toBe(rose.primary);
      expect(t.colors.accent).toBe(rose.accent);
      expect(t.mood).toBe('rose-bistro');
    });

    it('falls back to house defaults for an unknown mood', () => {
      const t = buildTheme({ mood: 'not-a-real-mood' as never }, 'dark');
      expect(t.colors.primary).toBe(BRAND.amber500);
      expect(t.colors.accent).toBe(BRAND.lime500);
      expect(t.mood).toBeNull();
    });

    it('resolves every mood preset without throwing', () => {
      for (const mood of MOODS) {
        const t = buildTheme({ mood: mood.key }, 'dark');
        expect(t.colors.primary).toBe(mood.primary);
        expect(t.colors.accent).toBe(mood.accent);
      }
    });
  });

  describe('typography resolution', () => {
    it('defaults to editorial (italic serif) when unset', () => {
      const t = buildTheme(null, 'dark');
      expect(t.typography.key).toBe('editorial');
      expect(t.typography.displayFamily).toBe('Fraunces_600SemiBold_Italic');
      expect(t.typography.headingTransform).toBe('none');
    });

    it('resolves modern as uppercase tracked sans', () => {
      const t = buildTheme({ typography: 'modern' }, 'dark');
      expect(t.typography.key).toBe('modern');
      expect(t.typography.displayFamily).toBe('Inter_700Bold');
      expect(t.typography.headingTransform).toBe('uppercase');
      expect(t.typography.headingTracking).toBeGreaterThan(0);
    });

    it('resolves minimal as plain sentence-case sans', () => {
      const t = buildTheme({ typography: 'minimal' }, 'dark');
      expect(t.typography.key).toBe('minimal');
      expect(t.typography.displayFamily).toBe('Inter_600SemiBold');
      expect(t.typography.headingTransform).toBe('none');
      expect(t.typography.headingTracking).toBe(0);
    });

    it('falls back to editorial for an unknown typography key', () => {
      const t = buildTheme({ typography: 'weird' as TypographyKey }, 'dark');
      expect(t.typography.key).toBe('editorial');
    });

    it('exposes the full loaded font family map', () => {
      const t = buildTheme(null, 'dark');
      expect(t.fonts.body).toBe('Inter_400Regular');
      expect(t.fonts.bodyBold).toBe('Inter_700Bold');
      expect(t.fonts.displayItalic).toBe('Fraunces_600SemiBold_Italic');
    });

    it('exports all three typography keys', () => {
      expect(TYPOGRAPHY_KEYS).toEqual(['editorial', 'modern', 'minimal']);
    });
  });

  describe('elevation + wash surfaces', () => {
    it('derives a low-alpha primary wash from the brand color', () => {
      const t = buildTheme({ brandPrimary: '#FFA319' }, 'dark');
      expect(t.colors.primaryWash).toBe('rgba(255, 163, 25, 0.16)');
    });

    it('bakes an OPAQUE primary tint (blend over the card) for elevated surfaces', () => {
      const d = buildTheme(null, 'dark');
      const l = buildTheme(null, 'light');
      expect(d.colors.primaryTint).toBe(mixHex(BRAND.amber500, INK_SCALE_DARK[800], 0.16));
      expect(l.colors.primaryTint).toBe(mixHex(BRAND.amber500, INK_SCALE_LIGHT[800], 0.12));
      // Opaque = a 6-digit hex, never an rgba() string (which breaks Android shadows).
      expect(d.colors.primaryTint).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('bevel is a subtle highlight in dark, transparent in light', () => {
      expect(buildTheme(null, 'dark').colors.bevel).toBe('rgba(255,255,255,0.06)');
      expect(buildTheme(null, 'light').colors.bevel).toBe('transparent');
    });

    it('exposes card + raised shadow presets, deeper in dark', () => {
      const d = buildTheme(null, 'dark');
      const l = buildTheme(null, 'light');
      expect(d.elevation.card.shadowOpacity).toBeGreaterThan(l.elevation.card.shadowOpacity);
      expect(d.elevation.raised.shadowRadius).toBeGreaterThan(d.elevation.card.shadowRadius);
    });
  });

  describe('hexToRgba', () => {
    it('expands #RGB and converts #RRGGBB', () => {
      expect(hexToRgba('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
      expect(hexToRgba('#FFA319', 0.16)).toBe('rgba(255, 163, 25, 0.16)');
      expect(hexToRgba('000000', 1)).toBe('rgba(0, 0, 0, 1)');
    });
    it('returns the input unchanged when not a hex', () => {
      expect(hexToRgba('rebeccapurple', 0.5)).toBe('rebeccapurple');
      expect(hexToRgba('#12', 0.5)).toBe('#12');
    });
  });

  describe('mixHex', () => {
    it('blends two colors to an opaque hex, expanding #RGB', () => {
      expect(mixHex('#fff', '#000', 0.5)).toBe('#808080');
      expect(mixHex('#000000', '#ffffff', 0)).toBe('#ffffff'); // t=0 → bg
      expect(mixHex('#FFA319', '#000000', 1)).toBe('#ffa319'); // t=1 → fg
    });
    it('zero-pads channels so the result is always 6 digits', () => {
      expect(mixHex('#010101', '#000000', 1)).toBe('#010101');
    });
    it('returns fg unchanged when either color is not hex', () => {
      expect(mixHex('rebeccapurple', '#000', 0.5)).toBe('rebeccapurple');
      expect(mixHex('#123456', 'notacolor', 0.5)).toBe('#123456');
    });
  });

  describe('scale passthrough', () => {
    it('exposes spacing, radii, text and motion scales', () => {
      const t = buildTheme(null, 'dark');
      expect(t.spacing[4]).toBe(16);
      expect(t.radii.md).toBe(12);
      expect(t.text.sm).toBe(12);
      expect(t.motion.durBase).toBe(180);
      expect(t.fieldRhythm.sectionGap).toBe(36);
    });

    it('exposes the extended v2 type ramp and paired type styles', () => {
      const t = buildTheme(null, 'dark');
      // v1 keys keep their values (Phase 0 parity)…
      expect(t.text.lg).toBe(15);
      // …and the ramp extends into display tiers.
      expect(t.text['2xl']).toBe(20);
      expect(t.text.display).toBe(34);
      expect(t.text.displayLg).toBe(44);
      expect(t.typeStyles).toBe(TYPE_STYLES);
      expect(t.typeStyles.display.lineHeight).toBeGreaterThan(t.typeStyles.display.size);
      expect(t.typeStyles.displayLg.tracking).toBeLessThan(0);
    });
  });

  describe('v2 surfaces, stamps and interaction tokens', () => {
    it('maps surface levels 0–3 onto page/panel/card/elevated', () => {
      const t = buildTheme(null, 'dark');
      expect(t.colors.surfaces[0]).toBe(t.colors.bg);
      expect(t.colors.surfaces[1]).toBe(t.colors.surface);
      expect(t.colors.surfaces[2]).toBe(t.colors.card);
      expect(t.colors.surfaces[3]).toBe(t.colors.cardElevated);
    });

    it.each(['dark', 'light'] as const)(
      'derives every stamp tone as an OPAQUE triple over the card (%s)',
      (scheme) => {
        const t = buildTheme(null, scheme);
        const tones: StampTone[] = ['neutral', 'info', 'warn', 'success', 'danger', 'brand'];
        for (const tone of tones) {
          const s = t.colors.stamp[tone];
          // Opaque 6-digit hex, never rgba — Android elevation artifact guard.
          expect(s.bg).toMatch(HEX6);
          expect(s.border).toMatch(HEX6);
          expect(s.fg).toBeTruthy();
        }
      },
    );

    it('uses the fixed per-scheme foregrounds for non-brand stamp tones', () => {
      const d = buildTheme(null, 'dark');
      const l = buildTheme(null, 'light');
      expect(d.colors.stamp.success.fg).toBe(stampToneFgFor('dark').success);
      expect(l.colors.stamp.danger.fg).toBe(stampToneFgFor('light').danger);
    });

    it('brand stamp fg is the raw primary on dark, darkened toward ink on light', () => {
      const d = buildTheme(null, 'dark');
      const l = buildTheme(null, 'light');
      expect(d.colors.stamp.brand.fg).toBe(BRAND.amber500);
      expect(l.colors.stamp.brand.fg).toBe(mixHex(BRAND.amber500, '#000000', 0.72));
      expect(l.colors.stamp.brand.fg).toMatch(HEX6);
    });

    it('follows a tenant brand override into the brand stamp', () => {
      const t = buildTheme({ brandPrimary: '#3D7BFF' }, 'dark');
      expect(t.colors.stamp.brand.fg).toBe('#3D7BFF');
    });

    it('exposes focus ring, skeleton fills and touch minimums', () => {
      const d = buildTheme(null, 'dark');
      const l = buildTheme(null, 'light');
      expect(d.focus.ringColor).toBe(d.colors.primary);
      expect(d.focus.ringWidth).toBeGreaterThan(0);
      // Skeleton fills are opaque ink steps per scheme.
      expect(d.skeleton).toEqual({ base: d.colors.ink[800], highlight: d.colors.ink[700] });
      expect(l.skeleton).toEqual({ base: l.colors.ink[850], highlight: l.colors.ink[900] });
      expect(d.touch).toBe(TOUCH);
      expect(d.touch.min).toBe(44);
    });

    it('resolves moods through MOODS_V2 (same keys as v1)', () => {
      expect(MOODS_V2.map((m) => m.key)).toEqual(MOODS.map((m) => m.key));
      for (const mood of MOODS_V2) {
        const t = buildTheme({ mood: mood.key }, 'light');
        expect(t.colors.primary).toBe(mood.primary);
      }
    });
  });
});
