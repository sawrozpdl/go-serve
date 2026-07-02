/**
 * Central haptics gate. All vibration feedback in the app routes through here so
 * a single per-device toggle (useHapticsPrefs, default OFF) can disable it. The
 * pref is read non-reactively so this works in callbacks, effects and module
 * scope alike. When off, the calls are cheap no-ops.
 */
import * as Haptics from 'expo-haptics';
import { useHapticsPrefs } from '../stores/hapticsPrefs';

const on = () => useHapticsPrefs.getState().enabled;

export const haptics = {
  /** Light tick for discrete selections (add item, tab press, stepper, …). */
  selection() {
    if (on()) void Haptics.selectionAsync();
  },
  /** Success buzz for completions (order sent, tab settled, new ticket). */
  notifySuccess() {
    if (on()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  },
};
