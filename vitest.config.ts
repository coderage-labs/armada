import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', '**/e2e/**'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
