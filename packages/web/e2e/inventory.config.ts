import { resolve } from 'node:path'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
export default {
  tests: './inventory.e2e.ts', workers: 1, timeout: 60_000, assertionTimeout: 10_000,
  output: '.e2e/inventory',
  targets: [{ engine: web(), app: {
    url: 'http://127.0.0.1:0',
    command: { executable: process.execPath, args: [resolve(import.meta.dirname, '../../../node_modules/vite/bin/vite.js'), '--config', resolve(import.meta.dirname, 'inventory.vite.config.ts'), '--host', '127.0.0.1', '--port', '{port}'], log: '.e2e/inventory/app.log' },
  } }],
} satisfies E2EConfig
