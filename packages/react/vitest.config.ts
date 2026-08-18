import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'react',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,mjs}'],
  },
})
