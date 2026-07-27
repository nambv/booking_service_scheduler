import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Spinning up a real Postgres container in beforeAll is slow; the domain and
    // application unit tests finish in milliseconds and are unaffected by the
    // raised ceilings.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
