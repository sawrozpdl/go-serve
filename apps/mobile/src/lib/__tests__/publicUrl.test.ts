import { normalizeOrigin, publicMenuUrl } from '../publicUrl';

describe('normalizeOrigin', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeOrigin('https://x.com/')).toBe('https://x.com');
    expect(normalizeOrigin('  https://x.com///  ')).toBe('https://x.com');
    expect(normalizeOrigin('https://x.com')).toBe('https://x.com');
  });
});

describe('publicMenuUrl', () => {
  it('builds /menu/<slug> from an explicit base', () => {
    expect(publicMenuUrl('sahan', 'https://go.example.com')).toBe('https://go.example.com/menu/sahan');
    expect(publicMenuUrl('sahan', 'https://go.example.com/')).toBe('https://go.example.com/menu/sahan');
  });

  it('falls back to the configured base when none is passed', () => {
    // No EXPO_PUBLIC_* menu/api base in the test env → empty origin.
    expect(publicMenuUrl('sahan')).toBe('/menu/sahan');
  });
});
