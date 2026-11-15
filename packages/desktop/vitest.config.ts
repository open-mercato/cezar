import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['scripts/**/*.test.mjs'],
  },
})
