import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// This file lives at packages/cezar/test/e2e; the alias package it guards is at the REPO
// root, because it is published alongside this package rather than from inside it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const aliasBin = join(repoRoot, 'alias-cezar', 'bin.js');
const packageManifest = join(repoRoot, 'packages', 'cezar', 'package.json');

/**
 * The `cezar-cli` alias must import this package through a specifier its `exports` map
 * actually exposes.
 *
 * 0.9.3 shipped an alias whose `bin.js` did `import('@open-mercato/cezar/dist/index.js')`
 * while this manifest exported only `.`, `./app-type` and `./package.json`. Once a package
 * declares `exports`, Node serves ONLY the listed subpaths and hard-blocks the rest — so
 * every `npx cezar-cli` died with ERR_PACKAGE_PATH_NOT_EXPORTED against a file that was
 * sitting right there in the tarball (#851).
 *
 * Nothing else in the gate could see it. The manifest's own `bin` entries name the same
 * path and work fine, because bin paths resolve inside the package and never pass through
 * the exports gate; `check:pack` counts packed files rather than resolving them; and the
 * release e2e drives a synthetic fixture whose `bin.js` is a bare shebang. The break was
 * only reachable by resolving the real specifier against the real manifest from OUTSIDE
 * the package — which is what this does.
 *
 * Resolution is all it takes: Node applies the exports gate while resolving, before it
 * ever touches the target file, so this needs the manifest only and runs green on a fresh
 * checkout with no `dist/`.
 */

/** Every `@open-mercato/cezar` specifier the alias entry point imports. */
async function aliasSpecifiers(): Promise<string[]> {
  const source = await readFile(aliasBin, 'utf8');
  const pattern = /['"](@open-mercato\/cezar(?:\/[^'"]*)?)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

test('the cezar-cli alias imports a specifier the exports map exposes', async () => {
  const specifiers = await aliasSpecifiers();
  // A computed specifier would slip past the regex; fail loudly rather than vacuously pass.
  assert.ok(
    specifiers.length > 0,
    `${aliasBin} names no literal @open-mercato/cezar specifier — this guard can no longer see what the alias imports`,
  );

  const root = await mkdtemp(join(tmpdir(), 'cezar-alias-exports-'));
  try {
    // A consumer that has only the published manifest installed — the exports gate reads
    // nothing else, so this reproduces a real `npx cezar-cli` resolution exactly.
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    const installed = join(root, 'node_modules', '@open-mercato', 'cezar');
    await mkdir(installed, { recursive: true });
    await copyFile(packageManifest, join(installed, 'package.json'));

    for (const specifier of specifiers) {
      const resolved = await execFile(
        process.execPath,
        ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
        { cwd: root },
      ).catch((error: Error & { stderr?: string }) => {
        assert.fail(
          `the alias imports '${specifier}', which the @open-mercato/cezar exports map does not expose — ` +
            `npx cezar-cli would fail for every user (#851): ${error.stderr?.trim() ?? error.message}`,
        );
      });

      // Whatever entry point the alias picks, it has to land on the CLI itself.
      assert.match(
        resolved.stdout.trim(),
        /\/dist\/index\.js$/,
        `the alias specifier '${specifier}' resolves to ${resolved.stdout.trim()}, not the CLI entry point`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
