// Tiny synthesised "boop" — used by the Kitchen Display when a new ticket
// arrives so kitchen staff don't have to keep watching the screen.
//
// Why hand-roll instead of an .mp3:
//   * Zero asset weight (~30 lines, no fetch).
//   * Browsers throttle/block autoplay of *files*; resumed AudioContexts
//     play fine after one user gesture.
//   * The tone is parameterised so we can tweak warmth (frequency, decay)
//     without touching an audio editor.
//
// User pref: persisted under `cafe-sound-enabled` in localStorage. Default
// on (kitchen staff *want* the alert; admins on other pages can mute).

const STORAGE_KEY = 'cafe-sound-enabled';
const THROTTLE_MS = 1500;

let ctx: AudioContext | null = null;
let lastPlayedAt = 0;
let unlocked = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  // Safari uses webkit prefix.
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** Most browsers require a user gesture to start audio. Wire this up to
 *  the first click/keydown so subsequent `playBoop()` calls fire silently
 *  without an autoplay-blocked warning in devtools. */
export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  // Calling resume() inside a user-gesture handler is what unlocks playback.
  void c.resume().catch(() => {});
  unlocked = true;
}

/** Play a two-tone boop (high → low, ~120ms total). Throttled — a burst of
 *  five new tickets becomes a single chirp, not a machine-gun. */
export function playBoop() {
  if (!isSoundEnabled()) return;
  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  lastPlayedAt = now;

  const c = getCtx();
  if (!c) return;

  const t0 = c.currentTime;
  // Two short sine pings — feel ChatGPT-voice-end-ish (warm, non-alarming).
  ping(c, t0, 880, 0.07);
  ping(c, t0 + 0.08, 660, 0.12);
}

function ping(c: AudioContext, when: number, freq: number, dur: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Quick attack + exponential decay — sounds like a clean glass tap.
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.18, when + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

export function isSoundEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // Default: on. Only off if the user explicitly muted.
    return v !== '0';
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* private mode — ignore */
  }
}
