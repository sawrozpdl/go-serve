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
    // so the installed app's SHA-1 has no matching Android OAuth client. Retrying
    // cannot fix that, which is why it — and only it — leaves the login screen.
    expect(
      classifyGoogleFailure(
        new Error(
          'DEVELOPER_ERROR: Follow troubleshooting instructions at https://react-native-google-signin.github.io/docs/troubleshooting',
        ),
      ),
    ).toEqual({ kind: 'no-access', reason: 'google-unavailable' });
  });

  it('treats a missing ID token and absent Play Services as the same dead end', () => {
    expect(classifyGoogleFailure(new Error('Google did not return an ID token.'))).toEqual({
      kind: 'no-access',
      reason: 'google-unavailable',
    });
    expect(classifyGoogleFailure({ message: 'PLAY_SERVICES_NOT_AVAILABLE' })).toEqual({
      kind: 'no-access',
      reason: 'google-unavailable',
    });
  });

  it('keeps a transient failure on the login screen, in the error banner', () => {
    // The regression this split exists for: a flat network or a 5xx from
    // /auth/google/native is fixed by tapping again, so it must NOT navigate the
    // user off a sign-in screen that works.
    expect(classifyGoogleFailure(new Error('Network request failed'))).toEqual({
      kind: 'retry',
      message: 'Network request failed',
    });
    expect(classifyGoogleFailure({ status: 503, message: 'Service unavailable' })).toEqual({
      kind: 'retry',
      message: 'Service unavailable',
    });
  });

  it('caps an unfamiliar message so a stack trace cannot take over the banner', () => {
    const out = classifyGoogleFailure(new Error('x'.repeat(300)));
    expect(out).toMatchObject({ kind: 'retry' });
    expect((out as { message: string }).message).toHaveLength(160);
  });

  it('falls back to its own words when the error has none', () => {
    const generic = { kind: 'retry', message: "Couldn't finish signing in with Google. Please try again." };
    expect(classifyGoogleFailure(undefined)).toEqual(generic);
    expect(classifyGoogleFailure({})).toEqual(generic);
    expect(classifyGoogleFailure(new Error('   '))).toEqual(generic);
  });
});
