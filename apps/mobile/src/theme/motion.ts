/**
 * Motion layer — the ONLY place Reanimated meets the MOTION design tokens.
 *
 * Screens and components consume the named presets/hooks below and never call
 * `FadeIn.duration(...)` (or hand-roll timings) directly, so the app's motion
 * stays on the token durations/eases and respects the OS reduce-motion
 * setting everywhere by construction.
 */
import { useEffect } from 'react';
import {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  withRepeat,
} from 'react-native-reanimated';
import { MOTION } from '@cafe-mgmt/design-tokens';

/** Token durations (ms). */
export const dur = {
  fast: MOTION.durFast,
  base: MOTION.durBase,
  slow: MOTION.durSlow,
} as const;

/** Token easings as Reanimated easing functions. */
export const ease = {
  out: Easing.bezier(...MOTION.easeOut),
  spring: Easing.bezier(...MOTION.easeSpring),
  in: Easing.bezier(...MOTION.easeIn),
} as const;

/* ── Entering / exiting / layout presets ────────────────────────────────
 * All presets carry ReduceMotion.System so they no-op when the OS asks. */

/** Content arriving: rise + fade (new list items, cards). */
export const enterUp = FadeInDown.duration(dur.base).easing(ease.out).reduceMotion(
  ReduceMotion.System,
);

/** Content arriving quietly: fade only (screens' secondary blocks). */
export const enterFade = FadeIn.duration(dur.fast).easing(ease.out).reduceMotion(
  ReduceMotion.System,
);

/** Content leaving: quick fade. */
export const exitFade = FadeOut.duration(dur.fast).easing(ease.in).reduceMotion(
  ReduceMotion.System,
);

/** Siblings re-flowing after an insert/remove (pair with enterUp/exitFade). */
export const listLayout = LinearTransition.duration(dur.base)
  .easing(ease.out)
  .reduceMotion(ReduceMotion.System);

/** Stagger helper: `entering={enterUpDelayed(index)}` for orchestrated
 * arrivals (login sequence, docket "print" moment). Capped so long lists
 * don't crawl. */
export function enterUpDelayed(index: number, stepMs: number = 40, capMs: number = 320) {
  return FadeInDown.duration(dur.base)
    .easing(ease.out)
    .delay(Math.min(index * stepMs, capMs))
    .reduceMotion(ReduceMotion.System);
}

/* ── Hooks ─────────────────────────────────────────────────────────────── */

/**
 * Spring-feel press feedback for pressable cards/buttons (replaces the
 * instant `pressed ? 0.98 : 1` ternaries). Spread `animatedStyle` on an
 * Animated.View inside the Pressable and wire the two callbacks.
 */
export function usePressScale(pressedScale: number = 0.97) {
  const pressed = useSharedValue(0);
  const reduced = useReducedMotion();

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (pressedScale - 1) * pressed.value }],
  }));

  const onPressIn = () => {
    if (reduced) return;
    pressed.value = withTiming(1, { duration: dur.fast, easing: ease.out });
  };
  const onPressOut = () => {
    if (reduced) return;
    pressed.value = withTiming(0, { duration: dur.base, easing: ease.spring });
  };

  return { animatedStyle, onPressIn, onPressOut };
}

/**
 * Error shake for form fields (failed OTP verify, rejected amount). Spread
 * `animatedStyle` on an Animated.View wrapping the field and call `shake()` in
 * the failure handler — a quick ±`offset`px oscillation that settles at 0.
 * No-op under reduce-motion, so a11y stays intact.
 */
export function useShake(offset: number = 6) {
  // A -1..1 oscillation scaled by `offset` at read time — mirrors usePressScale
  // (reading the shared value inside a computation, not as a bare alias, keeps
  // the React Compiler from freezing it and rejecting the mutation).
  const swing = useSharedValue(0);
  const reduced = useReducedMotion();

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swing.value * offset }],
  }));

  const shake = () => {
    if (reduced) return;
    swing.value = withSequence(
      withTiming(1, { duration: dur.fast, easing: ease.out }),
      withTiming(-1, { duration: dur.fast, easing: ease.out }),
      withTiming(1, { duration: dur.fast, easing: ease.out }),
      withTiming(-1, { duration: dur.fast, easing: ease.out }),
      withTiming(0, { duration: dur.fast, easing: ease.out }),
    );
  };

  return { animatedStyle, shake };
}

/**
 * Looped 0→1→0 progress for the Skeleton shimmer. Under reduce-motion (or
 * `enabled: false`) it stays at 0, leaving the skeleton static on its base
 * color.
 */
export function useShimmer(enabled: boolean = true) {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced || !enabled) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(progress);
  }, [reduced, enabled, progress]);

  return progress;
}
