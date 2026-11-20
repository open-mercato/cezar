import { resolve } from 'node:path'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import base from './e2e.config'

function appFor(name: string) {
  return {
    ...base.targets[0].app,
    command: {
      ...base.targets[0].app.command,
      env: { ...base.targets[0].app.command.env, CEZ_HOME: resolve('.e2e/cez-home', name) },
      log: `.e2e/logs/${name}.log`,
    },
  }
}

export default {
  ...base,
  workers: 1,
  tests: ['tests/manager-start.e2e.ts'],
  targets: [
    { name: 'ios-shell', engine: web({ browser: 'webkit', viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 CezarMobile/0.1.1 (ios)' }), app: appFor('manager-ios') },
    { name: 'android-shell', engine: web({ browser: 'chromium', viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 CezarMobile/0.1.1 (android)' }), app: appFor('manager-android') },
  ],
} satisfies E2EConfig
