import { defineConfig } from 'vitest/config'

// The service + CLI suite: Node ESM, no DOM, no bundler. `test/` is deliberately NOT included
// — those are the node:test suites (`npm run test:unit`, `npm run test:package`), which pack
// and install the real tarball and must not run inside the fast unit gate.
export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
