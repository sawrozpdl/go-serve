import { decodeJwtExpMs, msUntilRefresh, shouldRefreshNow } from '../jwt';

/** Build a fake JWT with the given payload (header/sig are ignored by decode). */
function makeJwt(payload: object): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

describe('decodeJwtExpMs', () => {
  it('reads exp (seconds) as milliseconds', () => {
    expect(decodeJwtExpMs(makeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  it('returns null when exp is missing', () => {
    expect(decodeJwtExpMs(makeJwt({ sub: 'u1' }))).toBeNull();
  });

  it('returns null when exp is not a number', () => {
    expect(decodeJwtExpMs(makeJwt({ exp: 'soon' }))).toBeNull();
  });

  it('returns null for a token without a payload segment', () => {
    expect(decodeJwtExpMs('onlyonesegment')).toBeNull();
  });

  it('returns null for an empty payload segment', () => {
    expect(decodeJwtExpMs('a..c')).toBeNull();
  });

  it('returns null for undecodable base64/JSON', () => {
    expect(decodeJwtExpMs('a.@@@notbase64@@@.c')).toBeNull();
  });
});

describe('msUntilRefresh', () => {
  const now = 1_000_000;
  it('fires leadMs before expiry', () => {
    expect(msUntilRefresh(now + 15 * 60_000, now)).toBe(15 * 60_000 - 60_000);
  });

  it('floors at minMs when expiry is near/past', () => {
    expect(msUntilRefresh(now + 10_000, now)).toBe(5_000); // 10s-60s < 5s floor
    expect(msUntilRefresh(now - 100_000, now)).toBe(5_000); // already expired
  });

  it('caps at the 32-bit setTimeout ceiling', () => {
    expect(msUntilRefresh(now + 10 ** 12, now)).toBe(0x7fffffff);
  });

  it('honors custom lead/min', () => {
    expect(msUntilRefresh(now + 100_000, now, 10_000, 1_000)).toBe(90_000);
  });
});

describe('shouldRefreshNow', () => {
  const now = 2_000_000;
  it('is true with no token', () => {
    expect(shouldRefreshNow(null, now)).toBe(true);
  });

  it('is true with an undecodable token', () => {
    expect(shouldRefreshNow('garbage', now)).toBe(true);
  });

  it('is true within the lead window', () => {
    expect(shouldRefreshNow(makeJwt({ exp: Math.floor((now + 30_000) / 1000) }), now)).toBe(true);
  });

  it('is false when comfortably fresh', () => {
    expect(shouldRefreshNow(makeJwt({ exp: Math.floor((now + 10 * 60_000) / 1000) }), now)).toBe(false);
  });
});
