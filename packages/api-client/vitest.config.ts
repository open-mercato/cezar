import { defineConfig } from 'vitest/config'

// Node environment on purpose: nothing in the api-client may need a DOM to be tested, and a
// jsdom here would hide an accidental browser-only dependency in a package that the Node
// service imports too.
export default defineConfig({
  test: {
    name: 'api-client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
