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
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

// Loaded lazily and kept: constructing a player per ticket would leak one per
// order on a busy night.
let player: AudioPlayer | null = null;

function get(): AudioPlayer | null {
  if (player) return player;
  try {
    player = createAudioPlayer(require('../../assets/sounds/new-ticket.wav'));
    return player;
  } catch {
    // No audio on this device / in this environment (tests, a simulator with
    // no output). Stay silent rather than throw.
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
