import { classifyGoogleFailure } from '../googleFailure';

describe('classifyGoogleFailure', () => {
  it('treats an explicit cancel code as a cancel', () => {
    expect(classifyGoogleFailure({ status: 0, code: 'cancelled', message: 'Sign-in was cancelled.' })).toBe(
      'cancelled',
    );
  });

  it('still recognises a cancel from the message alone', () => {
    // Belt-and-braces: the SDK's own copy has read both ways.
    expect(classifyGoogleFailure(new Error('Sign-in was cancelled.'))).toBe('cancelled');
    expect(classifyGoogleFailure(new Error('User canceled the flow'))).toBe('cancelled');
  });

  it('recognises the Play-signing failure a reviewer actually hits', () => {
    // Verbatim message from the rejected build: Play App Signing re-signs the AAB,
    // so the installed app's SHA-1 has no matching Android OAuth client.
    expect(
      classifyGoogleFailure(
        new Error(
          'DEVELOPER_ERROR: Follow troubleshooting instructions at https://react-native-google-signin.github.io/docs/troubleshooting',
        ),
      ),
    ).toEqual({ reason: 'google-unavailable' });
  });

  it('treats a missing ID token and absent Play Services as the same dead end', () => {
    expect(classifyGoogleFailure(new Error('Google did not return an ID token.'))).toEqual({
      reason: 'google-unavailable',
    });
    expect(classifyGoogleFailure({ message: 'PLAY_SERVICES_NOT_AVAILABLE' })).toEqual({
      reason: 'google-unavailable',
    });
  });

  it('carries an unfamiliar message through as detail, capped', () => {
    const long = 'x'.repeat(300);
    const out = classifyGoogleFailure(new Error(long));
    expect(out).toMatchObject({ reason: 'google-failed' });
    expect((out as { detail: string }).detail).toHaveLength(120);
  });

  it('falls back cleanly when there is no message at all', () => {
    expect(classifyGoogleFailure(undefined)).toEqual({ reason: 'google-failed' });
    expect(classifyGoogleFailure({})).toEqual({ reason: 'google-failed' });
    expect(classifyGoogleFailure(new Error('   '))).toEqual({ reason: 'google-failed' });
  });
});
