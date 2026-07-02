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
    // Route/screen files are verified via typecheck + selective smoke tests +
    // the dev client, not exhaustive RNTL — exclude from the % gate so the
    // number reflects the logic we DO unit-test.
    '!src/app/**',
    // Screen-level composite components (verified via dev client / integration,
    // their pure math lives in receipt-format + is 100% gated there).
    '!src/components/settle/SettleSheet.tsx',
    '!src/components/OfflineBanner.tsx',
    // Effect-only replay trigger (timers + store subscription) — the replay
    // logic it calls (runReplay) is unit-tested; the hook is dev-client tested.
    '!src/offline/useOfflineReplay.ts',
    // Native/platform glue that can't run in Node (asserted via mocks/E2E instead).
    '!src/theme/fontAssets.ts',
    '!src/printing/tcpPrinter.ts',
    '!src/realtime/useRealtime.ts',
    '!src/realtime/useConnectivityWatcher.ts',
    '!src/realtime/ws.ts',
    '!src/lib/kv.ts',
    '!src/api/queryClient.ts',
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
    'src/kitchen/board.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    'src/catalog/money.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    'src/finance/calc.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    // branches <100: the module-level env-var fallback chain can't be exercised
    // both ways in one test process.
    'src/lib/publicUrl.ts': { branches: 75, functions: 100, lines: 100, statements: 100 },
    // IP math + concurrency pool 100%; the only uncovered branches are option
    // defaults incl. the native probePrinter fallback (can't run in Node).
    'src/printing/discovery.ts': { branches: 80, functions: 100, lines: 100, statements: 100 },
    'src/offline/queue.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
    // runReplay + classifyFailure + execQueuedOp (the logic) at 100%; the
    // replayQueuedOps(qc) cache-wiring wrapper is dev-client/integration tested.
    'src/offline/replay.ts': { branches: 75, functions: 65, lines: 75, statements: 75 },
    // Whole-app floor. Business logic is held at 100% by the per-file gates
    // above; the global figure also includes data hooks + UI that are
    // integration/dev-client tested, so it sits lower. Raised as integration
    // (MSW) coverage grows in later milestones.
    global: {
      branches: 45,
      functions: 40,
      lines: 50,
      statements: 50,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
