import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('preserves an outer Windows-style home registry and backup while the home-safety suite runs', () => {
  const outerHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-home-isolation-'));
  try {
    const registry = join(outerHome, '.cezar', 'config.json');
    const backup = registry + '.bak';
    const sentinel = '{"projects":[{"id":"sentinel","root":"/repos/sentinel"}]}\n';
    mkdirSync(join(outerHome, '.cezar'));
    writeFileSync(registry, sentinel);
    writeFileSync(backup, sentinel);

    // Reproduce Windows home resolution on POSIX too, always inside an owned home (#1853).
    const preload = join(outerHome, 'windows-home.mjs');
    writeFileSync(preload, [
      "import os from 'node:os';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'os.homedir = () => process.env.USERPROFILE;',
      'syncBuiltinESMExports();',
    ].join('\n'));
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const vitestEntry = join(packageRoot, '..', '..', 'node_modules', 'vitest', 'vitest.mjs');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: outerHome,
      USERPROFILE: outerHome,
      CEZ_HOME: join(outerHome, 'pinned'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' '),
    };
    delete env.VITEST;
    const run = spawnSync(process.execPath, [vitestEntry, 'run', 'src/workspace/home-safety.test.ts'], {
      cwd: packageRoot, env, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL',
    });

    // Check preservation before the exit code: the original destructive case itself passes.
    expect(readFileSync(registry, 'utf8')).toBe(sentinel);
    expect(readFileSync(backup, 'utf8')).toBe(sentinel);
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('6 passed');
  } finally {
    rmSync(outerHome, { recursive: true, force: true });
  }
}, 200_000);
