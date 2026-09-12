/**
 * The new-ticket chime.
 *
 * Haptics are right on a handheld and useless on a wall-mounted KDS tablet:
 * nobody is touching it, so a buzz is a notification to an empty room. A bell
 * is the only alert that reaches a cook with their hands in a pan.
 *
 * Deliberately fire-and-forget. A ticket has already landed on the board by
 * the time this is called, and the audio session failing (a call in progress,
 * a device with output routed somewhere odd) must never take the board down
 * with it — a silent chime is a minor annoyance, a crashed kitchen screen
 * during service is not.
 */
import type { AudioPlayer } from 'expo-audio';

// Loaded lazily and kept: constructing a player per ticket would leak one per
// order on a busy night.
let player: AudioPlayer | null = null;

function get(): AudioPlayer | null {
  if (player) return player;
  try {
    // require, not a top-level import. expo-audio is a NATIVE module, and
    // importing it throws "Cannot find native module 'ExpoAudio'" at module
    // load on any binary that predates it — which is every existing install,
    // because JS reaches them over OTA and native code does not. A static
    // import put that throw above this try/catch, so the guard below was
    // decorative and the whole Kitchen screen went down with the sound.
    // Deferring it puts the failure back inside the net.
    // Deferring the load is the entire fix — a static import throws above this
    // try, where nothing can catch it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAudioPlayer } = require('expo-audio') as typeof import('expo-audio');
    player = createAudioPlayer(require('../../assets/sounds/new-ticket.wav'));
    return player;
  } catch {
    // No audio module, no audio on this device, or no output (tests, a
    // simulator). Stay silent rather than throw.
    return null;
  }
}

export function playNewTicketChime(): void {
  try {
    const p = get();
    if (!p) return;
    // Rewind first: a second ticket inside the sound's own length would
    // otherwise be silent, which is precisely when you most need to hear it.
    p.seekTo(0);
    p.play();
  } catch {
    /* see the note above — never let the board fall over for a sound */
  }
}

/** Drop the cached player. Called when the kitchen board unmounts so a phone
 *  that has left the screen is not holding an audio session open. */
export function releaseChime(): void {
  try {
    player?.remove();
  } catch {
    /* nothing to do */
  }
  player = null;
}
