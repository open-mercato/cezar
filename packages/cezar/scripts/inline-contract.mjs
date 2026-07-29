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
 * build folds it in: esbuild compiles the contract's source to one ESM file under `dist/contract/`,
 * `tsc` emits its declarations beside it, and the emitted references are repointed at both.
 *
 * Nothing is copied at the SOURCE level — the package graph still states the dependency, and this
 * runs only when `dist` actually names it. Delete this the day the contract is published, or the
 * day nothing here imports a contract VALUE.
 *
 * DECLARATIONS ship next to the bundle, and that is not optional. The scan below matches `.d.ts`
 * as well as `.js`, so emitted type imports get repointed too (`dist/ui-state.d.ts` names
 * `WorkspaceUiState`). esbuild emits JavaScript only, so a bundle on its own leaves those
 * declarations naming a module TypeScript cannot resolve — `TS7016`, and the type silently
 * degrades to `any` for anyone consuming the published package. Every tsconfig here sets
 * `skipLibCheck`, so nothing in this repo would have said a word. `tsc --emitDeclarationOnly`
 * mirrors the contract's `src` tree into `dist/contract/`, which is what makes
 * `./contract/index.js` resolve to a real `./contract/index.d.ts`.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const contractRoot = join(here, '..', '..', 'contract');
const entry = join(contractRoot, 'src', 'index.ts');
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

// `tsc` is located through the module graph rather than a guessed `node_modules` path, because
// `typescript` is a devDependency of THIS package and may sit here or be hoisted to the workspace
// root. Via the manifest's own `bin` entry: TypeScript 7's `exports` map does not publish
// `./bin/tsc`, so resolving that subpath directly is ERR_PACKAGE_PATH_NOT_EXPORTED.
const require_ = createRequire(import.meta.url);
const tsManifest = require_.resolve('typescript/package.json');
const tscBin = join(dirname(tsManifest), require_(tsManifest).bin.tsc);

// The declarations for the bundle above. `tsc` mirrors `src/**` into `outdir`, so `index.d.ts`
// lands beside `index.js` and its relative siblings (`./health.js` → `./health.d.ts`) resolve as
// TypeScript expects. Those siblings have no runtime twin, which is correct: the bundle is
// self-contained and nothing imports those paths at runtime.
execFileSync(
  process.execPath,
  [
    tscBin,
    '--project',
    join(contractRoot, 'tsconfig.json'),
    '--emitDeclarationOnly',
    '--declarationMap',
    'false',
    '--sourceMap',
    'false',
    '--outDir',
    outdir,
  ],
  { stdio: 'inherit' },
);
if (!existsSync(join(outdir, 'index.d.ts'))) {
  console.error('inline-contract: tsc emitted no index.d.ts — the bundled contract would ship untyped');
  process.exit(1);
}

for (const p of referrers) {
  let rel = relative(dirname(p), join(outdir, 'index.js')).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  writeFileSync(p, readFileSync(p, 'utf8').replace(SPEC, `'${rel}'`), 'utf8');
}
console.log(`inline-contract ok — contract bundled with declarations, ${referrers.length} file(s) repointed`);
