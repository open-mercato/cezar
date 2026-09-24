import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(packageRoot, 'dist');

/**
 * The `postbuild` contract inlining (`scripts/inline-contract.mjs`), checked on the real `dist`.
 *
 * This package is published; the contract it imports a zod VALUE from is not. The build therefore
 * bundles the contract into `dist/contract/` and repoints the emitted references at it. The bundle
 * alone is not enough: the scan repoints `.d.ts` files too, so declarations must ship beside it or
 * every repointed type import resolves to nothing and silently becomes `any`.
 *
 * Nothing else in the gate can see that. Every tsconfig in this repo sets `skipLibCheck`, which is
 * exactly what suppresses the resulting `TS7016`, and `check:pack` counts files rather than
 * type-checking them — so a build that shipped untyped declarations passed green. Hence this,
 * which runs after `npm run build` like the rest of `test:package`.
 */

/** Every emitted file that names the bundled contract, and the specifier it names it by. */
async function referrers(): Promise<{ file: string; specifier: string }[]> {
  const found: { file: string; specifier: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        if (path !== join(dist, 'contract')) await walk(path);
      } else if (/\.(js|d\.ts)$/.test(item.name)) {
        for (const match of (await readFile(path, 'utf8')).matchAll(/'([^']*contract\/index\.js)'/g)) {
          found.push({ file: path, specifier: match[1] as string });
        }
      }
    }
  };
  await walk(dist);
  return found;
}

test('the build repointed something — otherwise every assertion below is vacuous', async () => {
  assert.ok(existsSync(dist), 'dist/ is missing; test:package runs after `npm run build`');
  const found = await referrers();
  assert.ok(
    found.length > 0,
    'no dist file names ./contract/index.js. Either the contract is published now (delete ' +
      'scripts/inline-contract.mjs and this suite) or the repointing silently stopped working.',
  );
});

test('the bundled contract ships declarations, not just JavaScript', async () => {
  const found = await referrers();
  if (found.length === 0) return; // the guard above owns that failure

  assert.ok(
    existsSync(join(dist, 'contract', 'index.js')),
    'dist/contract/index.js is missing — the esbuild bundle did not run',
  );
  assert.ok(
    existsSync(join(dist, 'contract', 'index.d.ts')),
    'dist/contract/index.js has no index.d.ts beside it. Consumers of the published package ' +
      'would hit TS7016 and every contract type would degrade to `any`.',
  );

  // A `.d.ts` naming the bundle is the case that actually breaks: TypeScript resolves the
  // specifier to a sibling declaration, so one must exist for each.
  for (const { file, specifier } of found.filter((r) => r.file.endsWith('.d.ts'))) {
    const declaration = resolve(dirname(file), specifier).replace(/\.js$/, '.d.ts');
    assert.ok(
      existsSync(declaration),
      `${relative(packageRoot, file)} imports types from ${specifier}, but ` +
        `${relative(packageRoot, declaration)} does not exist`,
    );
  }
});

test('a repointed declaration type-checks with skipLibCheck OFF', async () => {
  const declarations = (await referrers()).filter((r) => r.file.endsWith('.d.ts'));
  if (declarations.length === 0) return;

  // `skipLibCheck` is on in every tsconfig here, which is precisely what hid the broken import.
  // The probe turns it off and imports each repointed module the way a consumer would.
  const scratch = await mkdtemp(join(tmpdir(), 'cezar-inline-contract-'));
  try {
    const imports = declarations
      .map(({ file }, i) => `import type * as m${i} from '${file.replace(/\.d\.ts$/, '.js')}';`)
      .join('\n');
    const probe = join(scratch, 'probe.ts');
    await writeFile(probe, `${imports}\nexport type Probe = ${declarations.map((_, i) => `typeof m${i}`).join(' | ')};\n`);

    const require_ = createRequire(import.meta.url);
    const manifest = require_.resolve('typescript/package.json');
    const tsc = join(dirname(manifest), (require_(manifest) as { bin: { tsc: string } }).bin.tsc);

    const { stdout, stderr } = await execFile(
      process.execPath,
      [tsc, '--noEmit', '--skipLibCheck', 'false', '--strict', '--module', 'nodenext', '--target', 'es2022', probe],
      { cwd: scratch },
    ).catch((err: { stdout?: string; stderr?: string }) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }));

    const output = `${stdout}${stderr}`;
    // TS7016 = no declaration file for the module; TS2307 = cannot find the module at all. Other
    // diagnostics are not this suite's business — a strict-mode complaint inside an unrelated
    // declaration should not fail the build gate.
    const unresolved = output
      .split('\n')
      .filter((line) => line.includes('TS7016') || line.includes('TS2307'));
    assert.deepEqual(
      unresolved,
      [],
      `a repointed declaration names a module TypeScript cannot resolve:\n${unresolved.join('\n')}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
