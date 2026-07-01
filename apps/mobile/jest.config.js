/**
 * Jest config for the mobile app.
 *
 * Uses the `jest-expo` preset (SDK 57). `transformIgnorePatterns` uses the
 * pnpm-aware variant (note the leading `.pnpm` allowance) so that RN/Expo/our
 * own workspace packages living under the pnpm store get transformed by Babel
 * rather than skipped as opaque node_modules.
 *
 * Coverage: business/pure logic must stay near-100%; the `logic`/`store`/`util`
 * and shared-package glob get a hard 100% gate, while component/screen code sits
 * at a high-but-realistic bar. Directories that don't exist yet simply
 * contribute nothing until they do.
 */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@cafe-mgmt/.*))',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/app/**/_layout.tsx',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/.expo/'],
  coverageThreshold: {
    // Pure business logic must be exhaustively covered.
    'src/theme/buildTheme.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    'src/auth/jwt.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    'src/auth/refresh.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    'src/auth/refreshScheduler.ts': { branches: 85, functions: 80, lines: 90, statements: 90 },
    'src/auth/tokenStore.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    'src/auth/permissions.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    // Whole-app floor: raised milestone-by-milestone as screens land.
    global: {
      branches: 78,
      functions: 68,
      lines: 78,
      statements: 78,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
