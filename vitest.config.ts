import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.mjs'],
    globalSetup: ['test/build.global-setup.ts'],
  },
});
