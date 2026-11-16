import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import base from './e2e.config';

export default {
  ...base,
  workers: 1,
  tests: ['tests/build-reload.e2e.ts'],
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1280, height: 800 } }), app: base.targets[0].app },
    { name: 'webkit-phone', engine: web({ browser: 'webkit', viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 CezarMobile/0.1.1 (ios)' }), app: base.targets[0].app },
  ],
} satisfies E2EConfig;
