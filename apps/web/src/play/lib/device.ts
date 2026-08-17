// =========================================================================
// Device identity for the play page.
//
// The server hashes whatever we send here with a per-tenant pepper, and uses it
// for the once-a-day gate. Two honest properties of that, both deliberate:
//
//   * a random localStorage id dominates the fingerprint, so clearing site data
//     mints a NEW identity and buys another attempt;
//   * it therefore almost never collides, so two guests with identical phones on
//     the café's wifi don't lock each other out.
//
// That trade is on purpose. A false "you already played today" is a worse guest
// experience than the occasional extra free coffee, and the campaign's budget
// caps — not this string — are what actually bound the café's loss. The stable
// hardware bits are mixed in so a casual "clear cookies and play again" at least
// takes effort, not because they are a security boundary.
// =========================================================================

const DEVICE_KEY = 'play.device.v1';

function randomId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A stable-ish per-device id, created on first visit and kept afterwards. */
function persistentId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const fresh = randomId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Private browsing, or storage disabled entirely. A per-load id means this
    // guest gets a fresh attempt each time — acceptable, and far better than
    // throwing on a page whose whole job is to be effortless.
    return randomId();
  }
}

/** The fingerprint sent to the server. Never hashed here — the server adds its
 *  own pepper, so a client-side hash would only be a second name for the same
 *  string. */
export function deviceFingerprint(): string {
  const bits = [
    persistentId(),
    navigator.language,
    String(screen.width),
    String(screen.height),
    String(new Date().getTimezoneOffset()),
  ];
  return bits.join('|');
}

// =========================================================================
// Today's code, cached locally
//
// The server is the source of truth (bootstrap returns todays_code), but a
// guest who reloads on a flaky connection should still see the prize they just
// won rather than an empty screen while the request is in flight.
// =========================================================================

const CODE_KEY = 'play.code.v1';

export type CachedCode = {
  slug: string;
  code: string;
  label: string;
  expiresAt: string;
};

export function cacheCode(entry: CachedCode): void {
  try {
    localStorage.setItem(CODE_KEY, JSON.stringify(entry));
  } catch {
    /* storage unavailable — the server copy still covers a reload */
  }
}

/** Reads the cached code, dropping it once it has expired or belongs to another
 *  café. Expiry is judged against the server-issued timestamp, never a locally
 *  computed deadline, because a phone with a wrong clock is common and a code
 *  that looks alive but isn't is worse than no code at all. */
export function readCachedCode(slug: string): CachedCode | null {
  try {
    const raw = localStorage.getItem(CODE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCode;
    if (parsed.slug !== slug) return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(CODE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearCachedCode(): void {
  try {
    localStorage.removeItem(CODE_KEY);
  } catch {
    /* nothing to do */
  }
}

// =========================================================================
// Personal bests — what gives practice mode a point
// =========================================================================

const BEST_KEY = 'play.best.v1';

type BestRecord = { slug: string; day: string; today: number; allTime: number };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function readBest(slug: string): { today: number; allTime: number } {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return { today: 0, allTime: 0 };
    const parsed = JSON.parse(raw) as BestRecord;
    if (parsed.slug !== slug) return { today: 0, allTime: 0 };
    return {
      today: parsed.day === todayKey() ? parsed.today : 0,
      allTime: parsed.allTime,
    };
  } catch {
    return { today: 0, allTime: 0 };
  }
}

export function recordBest(slug: string, score: number): { today: number; allTime: number } {
  const current = readBest(slug);
  const next = {
    today: Math.max(current.today, score),
    allTime: Math.max(current.allTime, score),
  };
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify({ slug, day: todayKey(), ...next } satisfies BestRecord));
  } catch {
    /* best-effort only */
  }
  return next;
}
