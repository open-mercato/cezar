import { resolve } from 'node:path'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'

export default {
  tests: './chat-webhooks.e2e.ts',
  workers: 1,
  timeout: 90_000,
  assertionTimeout: 15_000,
  output: '.e2e/chat-webhooks',
  targets: [{
    engine: web({ viewport: { width: 1280, height: 1000 } }),
    app: {
      url: 'http://127.0.0.1:0',
      readyUrl: 'http://127.0.0.1:{port}/api/v1/health',
      command: {
        executable: process.execPath,
        args: [resolve(import.meta.dirname, 'chat-webhooks-server.mjs')],
        env: { PORT: '{port}' },
        startupTimeout: 120_000,
        log: '.e2e/chat-webhooks/app.log',
      },
    },
  }],
} satisfies E2EConfig
