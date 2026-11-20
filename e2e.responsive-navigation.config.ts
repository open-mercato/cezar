import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import base from './e2e.config'

export default {
  ...base,
  workers: 1,
  tests: ['tests/responsive-navigation.e2e.ts'],
  targets: [{ name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1280, height: 900 } }), app: base.targets[0].app }],
} satisfies E2EConfig
