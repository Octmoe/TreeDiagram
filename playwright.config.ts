import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/v2/e2e',
  testMatch: '*.spec.ts',
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  webServer: {
    command: 'node tests/v2/e2e/start-server.mjs',
    url: 'http://127.0.0.1:4321/api/v2/health',
    timeout: 120000,
    reuseExistingServer: false,
  },
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
