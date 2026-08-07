import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
      {
        test: {
          name: 'model-smoke',
          include: ['tests/model-smoke/**/*.test.ts'],
          environment: 'node',
          testTimeout: 300000,
        },
      },
    ],
  },
});
