import { defineConfig } from 'vitest/config'

/**
 * The e2e suite is deliberately NOT a project in the root vitest.config.ts: `npm test` is the
 * fast unit gate and must never need a running server or a browser. These specs run only via
 * `npm run test:e2e`, which boots the environment first.
 *
 * Plain node environment and no React plugin — the specs shell out to agent-browser and drive
 * a real Chrome; nothing here is bundled or rendered in jsdom.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    root: import.meta.dirname,
    environment: 'node',
    include: ['**/*.e2e.ts'],
    // One browser session, one server: parallel specs would fight over both.
    fileParallelism: false,
    // Pins the shared env's workspace registry to the single-project shape before any spec runs,
    // and restores it afterwards — otherwise whatever the operator last registered in the
    // gitignored `.ai/qa/cez-home` decides whether the sidebar renders its flat or its grouped
    // shell, and every spec asserting flat-shell selectors becomes a coin flip. See the module.
    globalSetup: ['./workspace-registry.ts'],
    // A real browser is slower than jsdom, but a smoke test that needs more than this is broken.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
