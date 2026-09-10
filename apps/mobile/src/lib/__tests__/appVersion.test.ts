/**
 * The version string that lands on a bug report. It used to be the literal
 * app name, which told triage nothing at all.
 */
import { formatAppVersion } from '../appVersion';

describe('formatAppVersion', () => {
  it('is just the release when running the bundled build', () => {
    expect(formatAppVersion('1.1.3', true, 'a3f9c1e2-dead-beef')).toBe('1.1.3');
  });

  it('names the OTA bundle when it is not the embedded one', () => {
    // Two phones on the same release can be running different JS.
    expect(formatAppVersion('1.1.3', false, 'a3f9c1e2-dead-beef')).toBe('1.1.3 (a3f9c1e2)');
  });

  it('falls back to the release when there is no update id', () => {
    expect(formatAppVersion('1.1.3', false, null)).toBe('1.1.3');
    expect(formatAppVersion('1.1.3', false, undefined)).toBe('1.1.3');
  });

  it('never reports an empty version', () => {
    expect(formatAppVersion(undefined, true, null)).toBe('unknown');
    expect(formatAppVersion('  ', true, null)).toBe('unknown');
  });
});
