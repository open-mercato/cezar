import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('the release tarball installs and runs the dry-run CLI workflow', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-package-e2e-'));

  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    const packed = await execFile(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const records = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const record = records[0];
    assert.ok(record, 'npm pack should describe the generated tarball');

    const packagedPaths = new Set(record.files.map((file) => file.path));
    for (const requiredPath of ['dist/index.js', 'web/dist/index.html', 'scripts/mock-claude.mjs', 'README.md']) {
      assert.ok(packagedPaths.has(requiredPath), `release tarball should contain ${requiredPath}`);
    }
    assert.equal(packagedPaths.has('src/index.ts'), false, 'release tarball should not contain TypeScript sources');
    assert.equal(packagedPaths.has('test/e2e/package-cli.test.ts'), false, 'release tarball should not contain tests');

    const consumerDir = join(root, 'consumer');
    await mkdir(consumerDir);
    await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
    const tarball = join(packDir, record.filename);
    await execFile(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
      { cwd: consumerDir, maxBuffer: 10 * 1024 * 1024 },
    );

    const packageRoot = join(consumerDir, 'node_modules', '@open-mercato', 'cezar');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: { cezar: string; cez: string; 'cezar-cli': string };
    };
    assert.equal(manifest.bin.cezar, 'dist/index.js');
    assert.equal(manifest.bin.cez, 'dist/index.js');
    assert.equal(manifest.bin['cezar-cli'], 'dist/index.js');
    const cliPath = join(packageRoot, manifest.bin.cezar);

    const help = await execFile(process.execPath, [cliPath, '--help'], {
      cwd: consumerDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(help.stdout, /cezar — local cockpit/);
    assert.match(help.stdout, /cezar run "<task>"/);

    const fixtureRepo = join(root, 'fixture-repo');
    await mkdir(fixtureRepo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, 'README.md'), '# E2E fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
    await execFile(
      'git',
      ['-c', 'user.name=Cezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'test fixture'],
      { cwd: fixtureRepo },
    );

    // CEZ_HOME pins every workspace write (migrations, project registry,
    // server.json) to a temp dir — booting the real CLI must never touch the
    // developer's real ~/.cezar.
    const cezHome = join(root, 'cez-home');
    const run = await execFile(process.execPath, [cliPath, 'run', 'mock:done', '--repo', fixtureRepo], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: cezHome },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(run.stdout, /run (done|review)/);

    const runs = JSON.parse(await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8')) as Array<{
      status: string;
    }>;
    assert.equal(runs.length, 1);
    assert.ok(['done', 'review'].includes(runs[0]?.status ?? ''), 'the dry-run workflow should finish successfully');

    // Boot wiring (spec 2026-07-20-multi-project-workspace, step 1.5): the
    // headless run migrated ~/.cezar and registered the boot repo.
    const workspace = JSON.parse(await readFile(join(cezHome, 'config.json'), 'utf8')) as {
      schemaVersion: number;
      projects: Array<{ name: string; root: string }>;
    };
    assert.ok(workspace.schemaVersion >= 1, 'boot runs the workspace migrations');
    assert.ok(
      workspace.projects.some((p) => p.name === 'fixture-repo'),
      'a headless run registers the boot repo in the workspace registry',
    );

    // `cezar projects` (step 5.2) reads the same registry with no server
    // running — the ssh-into-the-box view of Settings → Projects.
    const projects = await execFile(process.execPath, [cliPath, 'projects'], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_HOME: cezHome },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(projects.stdout, /fixture-repo/);
    assert.match(projects.stdout, /1 project\(s\)/);

    // server-install / server-uninstall dry-run round-trip. CEZ_HOME isolates
    // ~/.cezar/server.json to a temp dir; CEZ_DRY_RUN performs no real sudo.
    assert.match(help.stdout, /cezar server-install/);
    const serverEnv = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: cezHome };
    const serverExec = { cwd: consumerDir, env: serverEnv, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 } as const;

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const state = JSON.parse(await readFile(join(cezHome, 'server.json'), 'utf8')) as {
      platform: string;
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(state.platform, 'ubuntu-vps', 'server-install records the platform');
    assert.equal(state.installed, true, 'server-install flips installed=true when all required steps are done');
    assert.ok(state.steps['nginx-proxy'], 'server-install ran the nginx-proxy step');

    await execFile(
      process.execPath,
      [cliPath, 'server-uninstall', '--platform', 'ubuntu-vps', '--yes'],
      serverExec,
    );
    const reversed = JSON.parse(await readFile(join(cezHome, 'server.json'), 'utf8')) as {
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.deepEqual(reversed.steps, {}, 'server-uninstall reverses every step');
    assert.equal(reversed.installed, false, 'server-uninstall clears installed');

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--external-proxy', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const resumedExternal = JSON.parse(await readFile(join(cezHome, 'server.json'), 'utf8')) as {
      externalProxy?: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(resumedExternal.externalProxy, true, 'a flag-less resume preserves external-proxy mode');
    assert.ok(!resumedExternal.steps['nginx-proxy'], 'a flag-less resume does not add cezar-managed nginx');

    // Unknown platform exits non-zero.
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'server-install', '--platform', 'nope'], serverExec),
      'unknown platform should exit 1',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
