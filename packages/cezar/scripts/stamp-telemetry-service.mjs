#!/usr/bin/env node
// Public releases only (release.yml, nightly.yml): stamp the telemetry service into the built
// package, after `npm run build`. Every other build (local, worktree, PR preview) carries no stamp
// and reports under the development service id hard-coded in src/telemetry.ts.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const service = (process.env.CEZ_TELEMETRY_SERVICE ?? '').trim();
// The worker's `service` rule: ≤64 chars of letters, digits and `. _ : @ / + -`.
if (!/^[\w.:@/+-]{1,64}$/.test(service)) {
  console.error(
    'stamp-telemetry-service: CEZ_TELEMETRY_SERVICE is missing or invalid — a public release must ' +
      'carry its telemetry service (set the repository secret CEZ_TELEMETRY_SERVICE).',
  );
  process.exit(1);
}
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'telemetry-service.json');
writeFileSync(target, `${JSON.stringify({ service })}\n`);
console.log('stamp-telemetry-service: telemetry service stamped into dist/telemetry-service.json');
