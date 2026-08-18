import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'react',
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
})
