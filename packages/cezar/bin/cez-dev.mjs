#!/usr/bin/env node
// `CEZ_BIN` for a source checkout: plain `node` cannot run src/index.ts (runnableCezBin in src/paths.ts, #2057).
let register;
try {
  ({ register } = await import('tsx/esm/api'));
} catch {
  console.error('cez: this source checkout cannot load tsx — run `npm ci` at the repository root (#2057)');
  process.exit(1);
}
register();
await import('../src/index.ts');
