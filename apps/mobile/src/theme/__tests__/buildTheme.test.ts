import { MOODS, BRAND, INK_SCALE_DARK, INK_SCALE_LIGHT } from '@cafe-mgmt/design-tokens';
import type { TenantBranding, TypographyKey } from '@cafe-mgmt/design-tokens';
import { buildTheme, TYPOGRAPHY_KEYS, hexToRgba, mixHex } from '../buildTheme';

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
  });
});
