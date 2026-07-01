import { MOODS, BRAND, INK_SCALE_DARK, INK_SCALE_LIGHT } from '@cafe-mgmt/design-tokens';
import type { TenantBranding, TypographyKey } from '@cafe-mgmt/design-tokens';
import { buildTheme, TYPOGRAPHY_KEYS } from '../buildTheme';

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
