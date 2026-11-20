import { fileURLToPath } from 'node:url'
import { web } from '@e2e-dev/web'
import type { E2EConfig } from 'e2e'

export default {
  tests: ['navigation.e2e.ts'],
  targets: [{
    engine: web(),
    app: {
      url: 'http://127.0.0.1:0',
      command: {
        executable: 'npm',
        cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
        args: ['run', 'dev:web', '--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'],
        startupTimeout: 60000,
      },
    },
  }],
} satisfies E2EConfig
