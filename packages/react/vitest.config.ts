import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const packageDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '#cezar-web-cockpit': resolve(packageDir, '../web/src/cockpit-implementation.tsx'),
      '@': resolve(packageDir, '../web/src'),
      '@open-mercato/cezar-react': resolve(packageDir, 'src/index.ts'),
    },
  },
  test: {
    name: 'react',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,mjs}'],
  },
})
