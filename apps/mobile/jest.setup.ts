/**
 * Global Jest setup, run after the test framework is installed.
 *
 * `@testing-library/react-native` v13 auto-cleans between tests and ships its
 * matchers built-in, so no extra matcher import is needed. Add module mocks
 * here as native modules are introduced in later milestones.
 */

// react-native-mmkv and expo-secure-store are auto-mocked from the root
// __mocks__ directory.

// expo-haptics: no-op in tests (no native haptics engine).
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
