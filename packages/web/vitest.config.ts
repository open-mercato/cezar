import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// Reuse the build config verbatim (root, React plugin, `@` → packages/web/src) and only add the
// test layer, so a component under test resolves its imports exactly like the shipped bundle.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
)
