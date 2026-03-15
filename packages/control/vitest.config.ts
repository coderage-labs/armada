import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/infrastructure/**', 'src/services/**', 'src/routes/**'],
      reporter: ['text', 'text-summary'],
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
