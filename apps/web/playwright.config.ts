import { defineConfig, devices } from '@playwright/test';

// E2E against the running dev stack: API on :9090, web (vite) on :5891.
// Auth is bootstrapped programmatically in e2e/auth.setup.ts (platform-admin
// OTP → tokens → localStorage storageState), so specs start already logged in
// to the /super console. Cleanup of test data runs in e2e/global-teardown.ts.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // shared dev DB + a single seeded tenant — keep it serial
  retries: 0,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5891',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
    },
  ],
});
