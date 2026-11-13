import { resolve } from 'node:path'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
export default {
  tests: './extensions.e2e.ts', workers: 1, timeout: 120_000, assertionTimeout: 15_000,
  output: '.e2e/extensions',
  targets: [{ engine: web({ viewport: { width: 1280, height: 1000 } }), app: {
    url: 'http://127.0.0.1:0', readyUrl: 'http://127.0.0.1:{port}/api/v1/health',
    command: { executable: process.execPath, args: ['--import', 'tsx', resolve(import.meta.dirname, 'extensions-server.mjs')], env: { PORT: '{port}' }, startupTimeout: 120_000, log: '.e2e/extensions/app.log' },
  } }],
} satisfies E2EConfig
