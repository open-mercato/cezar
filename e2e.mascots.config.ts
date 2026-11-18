import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
export default {
 tests: ['packages/web/artwork/mascots/studio.e2e.ts'],
 targets: [{ engine: web(), app: { url: 'http://127.0.0.1:5188' } }],
} satisfies E2EConfig;
