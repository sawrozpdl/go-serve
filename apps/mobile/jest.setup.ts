/**
 * Global Jest setup, run after the test framework is installed.
 *
 * `@testing-library/react-native` v13 auto-cleans between tests and ships its
 * matchers built-in, so no extra matcher import is needed. Add module mocks
 * here as native modules are introduced in later milestones.
 */

// react-native-mmkv and expo-secure-store are auto-mocked from the root
// __mocks__ directory.

// react-native-reanimated: hand-rolled mock. Neither the real module nor its
// shipped `react-native-reanimated/mock` load under Jest — both import the
// package initializers, which bind react-native-worklets' NATIVE module at
// import time. This stub covers the surface the app actually uses (the
// motion layer in src/theme/motion.ts + animated components); extend it as
// components adopt more of the API.
jest.mock('react-native-reanimated', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports
  const RN = require('react-native');

  // Chainable no-op builder for entering/exiting/layout presets.
  const CHAIN_METHODS = [
    'duration',
    'delay',
    'easing',
    'reduceMotion',
    'springify',
    'damping',
    'stiffness',
    'mass',
    'withCallback',
    'withInitialValues',
    'randomDelay',
    'build',
  ];
  const makeBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) b[m] = () => b;
    return b;
  };

  const id = <T>(v: T): T => v;

  return {
    __esModule: true,
    default: {
      View: RN.View,
      Text: RN.Text,
      ScrollView: RN.ScrollView,
      FlatList: RN.FlatList,
      Image: RN.Image,
      createAnimatedComponent: id,
    },
    createAnimatedComponent: id,
    Easing: {
      linear: id,
      ease: id,
      quad: id,
      cubic: id,
      sin: id,
      exp: id,
      in: id,
      out: id,
      inOut: id,
      bezier: () => ({ factory: id }),
    },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    FadeIn: makeBuilder(),
    FadeInDown: makeBuilder(),
    FadeInUp: makeBuilder(),
    FadeOut: makeBuilder(),
    LinearTransition: makeBuilder(),
    ZoomIn: makeBuilder(),
    useSharedValue: <T>(init: T) => ({ value: init }),
    useAnimatedStyle: (updater: () => object) => {
      try {
        return updater();
      } catch {
        return {};
      }
    },
    useDerivedValue: (updater: () => unknown) => ({ value: updater() }),
    useReducedMotion: () => false,
    useAnimatedScrollHandler: () => () => {},
    interpolate: () => 0,
    interpolateColor: () => 'transparent',
    Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
    withTiming: id,
    withSpring: id,
    withDelay: (_ms: number, v: unknown) => v,
    withRepeat: id,
    withSequence: (...vs: unknown[]) => vs[vs.length - 1],
    cancelAnimation: () => {},
    runOnJS: id,
    runOnUI: id,
  };
});

// @gorhom/bottom-sheet: start from the shipped mock, but make BottomSheetModal
// visibility-faithful — the shipped one renders children unconditionally, so
// "sheet closed → content hidden" tests would pass vacuously. present() shows
// children, dismiss() hides them and fires onDismiss (like the real close).
jest.mock('@gorhom/bottom-sheet', () => {
  /* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
  const actual = require('@gorhom/bottom-sheet/mock');
  const React = require('react');
  /* eslint-enable @typescript-eslint/no-require-imports */

  class BottomSheetModal extends React.Component {
    state = { visible: false };
    present = () => this.setState({ visible: true });
    dismiss = () => {
      if (this.state.visible) {
        this.setState({ visible: false });
        (this.props as { onDismiss?: () => void }).onDismiss?.();
      }
    };
    close = this.dismiss;
    forceClose = this.dismiss;
    snapToIndex() {}
    snapToPosition() {}
    expand() {}
    collapse() {}
    render() {
      if (!this.state.visible) return null;
      const kids = this.props.children;
      return typeof kids === 'function' ? kids({ data: undefined }) : kids;
    }
  }

  return { ...actual, BottomSheetModal };
});

// expo-haptics: no-op in tests (no native haptics engine).
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
