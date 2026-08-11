import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'contract-domain',
          include: ['tests/v2/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/v2/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});
