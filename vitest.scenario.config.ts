import { defineConfig } from 'vitest/config'

// Real-server fixture scenarios (architecture §11 tests/scenario). Not part of `npm test`.
export default defineConfig({
  test: {
    include: ['tests/scenario/**/*.scenario.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
