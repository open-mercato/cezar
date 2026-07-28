/**
 * Copy `src/contract/` into the api-client so it ships a self-contained contract.
 *
 * A zod schema is a VALUE, not a type, so the api-client cannot merely `import type` it the way
 * it names `AppType` today — re-exporting one would emit a real import and give a browser package
 * a runtime dependency on the server package. Copying the source instead keeps both packages
 * standalone: no runtime dependency in either direction, no build-order constraint (only the
 * `.ts` files are needed, not compiled output), and no requirement that either be published
 * first. Same trick as `sync-readme.mjs`, and for the same reason: one source, no drift.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'src', 'contract');
const to = join(here, '..', '..', 'api-client', 'src', 'contract');

const BANNER = `// GENERATED — do not edit. Source: packages/cezar/src/contract/\n// Refresh with: npm run sync-contract -w @open-mercato/cezar\n`;

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

let stamped = 0;
for (const name of readdirSync(to)) {
  if (!name.endsWith('.ts')) {
    rmSync(join(to, name), { recursive: true, force: true }); // README and friends stay behind
    continue;
  }
  const file = join(to, name);
  writeFileSync(file, BANNER + readFileSync(file, 'utf8'), 'utf8');
  stamped += 1;
}
console.log(`sync-contract ok — ${stamped} file(s) copied into packages/api-client/src/contract`);
