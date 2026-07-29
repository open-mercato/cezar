/**
 * Bundle `@open-mercato/cezar-contract` into `dist` after `tsc`.
 *
 * The contract and the api-client are PRIVATE and ship no build of their own — they are linked as
 * workspace packages and consumed as TypeScript source, which is what every other consumer wants:
 * the cockpit's Vite bundles them, vitest transforms them.
 *
 * This package is the exception, because it is PUBLISHED. `workspace/migrations.ts` imports
 * `workspaceUiStateSchema` — a zod value, not a type — so the installed CLI resolves the contract
 * at runtime, and a tarball naming a package npm has never seen would fail on install. So the
 * build folds it in: esbuild compiles the contract's source to one ESM file under `dist/contract/`
 * and the emitted references are repointed at it.
 *
 * Nothing is copied at the SOURCE level — the package graph still states the dependency, and this
 * runs only when `dist` actually names it. Delete this the day the contract is published, or the
 * day nothing here imports a contract VALUE.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const entry = join(here, '..', '..', 'contract', 'src', 'index.ts');
const outdir = join(dist, 'contract');
const SPEC = /(['"])@open-mercato\/cezar-contract\1/g;

/** Emitted files that name the package — the copy happens only if it is really used. */
const referrers = [];
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (p !== outdir) scan(p);
    } else if (/\.(js|d\.ts|js\.map)$/.test(entry.name)) {
      SPEC.lastIndex = 0;
      if (SPEC.test(readFileSync(p, 'utf8'))) referrers.push(p);
    }
  }
};
scan(dist);

rmSync(outdir, { recursive: true, force: true });
if (referrers.length === 0) {
  console.log('inline-contract ok — nothing in dist references the contract, nothing bundled');
  process.exit(0);
}

// `zod` stays external: it is a real dependency of this package, so npm resolves it normally and
// the tarball does not carry a second copy.
await build({
  entryPoints: [entry],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['zod'],
});

for (const p of referrers) {
  let rel = relative(dirname(p), join(outdir, 'index.js')).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  writeFileSync(p, readFileSync(p, 'utf8').replace(SPEC, `'${rel}'`), 'utf8');
}
console.log(`inline-contract ok — contract bundled, ${referrers.length} file(s) repointed`);
