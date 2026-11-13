import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// This file lives at packages/cezar/test/e2e; the orchestrator it drives is at the REPO root,
// because a release spans every workspace and belongs to none of them.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release.mts');
const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

// The .mts orchestrator imports packages/cezar/src/release/*.ts directly (through the tsx loader),
// so unlike the snapshot e2e this suite needs no build.

/** A miniature of the real workspace: the three publishable manifests, in their real
 *  directories, with the same intra-release dependency edges the pipeline has to re-pin. */
async function makeFixture(version = '0.1.5'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-release-'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fake-monorepo', private: true, version: '0.0.0' }, null, 2)}\n`,
  );

  // The extension SDK is published and FIRST in the set: the contract re-exports it.
  await mkdir(join(root, 'packages', 'extension-sdk'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'extension-sdk', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-sdk', version: '0.0.1', files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'extension-sdk', 'index.js'), 'export {};\n');

  for (const [dir, name] of [['telegram', '@scope/fake-telegram']] as const) {
    await mkdir(join(root, 'packages', 'chat-plugins', dir), { recursive: true });
    await writeFile(join(root, 'packages', 'chat-plugins', dir, 'package.json'), `${JSON.stringify({ name, version: '0.1.0', dependencies: { '@scope/fake-sdk': '^0.1.0' } }, null, 2)}\n`);
    const extension = JSON.parse(await readFile(join(repoRoot, 'packages/chat-plugins', dir, 'cezar-extension.json'), 'utf8'));
    await writeFile(join(root, 'packages/chat-plugins', dir, 'cezar-extension.json'), JSON.stringify({ ...extension, version: '0.1.0' }));
  }

  // The contract package joins the stamped set: private, so never published, but versioned in
  // lockstep and depended on by the api-client.
  await mkdir(join(root, 'packages', 'contract'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'contract', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-contract', version: '0.9.9', private: true, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'contract', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'api-client'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'api-client', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-client', version, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'api-client', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'cezar'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'cezar', 'package.json'),
    `${JSON.stringify(
      {
        name: '@scope/fake-root',
        version,
        files: ['index.js'],
        devDependencies: { '@scope/fake-client': `^${version}` },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'packages', 'cezar', 'index.js'), 'export {};\n');

  // Both unscoped aliases, each its own npx-resolvable package.
  for (const [dir, name] of [
    ['alias-cezar', 'fake-alias'],
    ['alias-cezar-run', 'fake-run-alias'],
  ] as const) {
    await mkdir(join(root, dir));
    await writeFile(
      join(root, dir, 'package.json'),
      `${JSON.stringify(
        {
          name,
          version,
          files: ['bin.js'],
          dependencies: { '@scope/fake-root': `^${version}` },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(root, dir, 'bin.js'), '#!/usr/bin/env node\n');
  }
  return root;
}

const readPkg = async (root: string, ...segments: string[]) =>
  JSON.parse(await readFile(join(root, ...segments, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

function runScript(fixtureRoot: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CEZ_RELEASE_ROOT: fixtureRoot,
    GITHUB_OUTPUT: join(fixtureRoot, 'github-output.txt'),
    NODE_AUTH_TOKEN: '',
    GITHUB_ACTIONS: '',
    ...extraEnv,
  };
  return execFile(process.execPath, ['--import', tsxLoader, script, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
}

test('a patch bump stamps every manifest, keeps the caret ranges, and emits the version', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);
    assert.match(stdout, /dist-tag latest/);
    // Dependency order: the client is published before the service that depends on it, and the
    // alias last of all. A dependent published first would advertise a version that is not on
    // the registry yet.
    assert.ok(
      stdout.indexOf('@scope/fake-client') < stdout.indexOf('@scope/fake-root'),
      'the api-client must be published before the service',
    );
    assert.ok(
      stdout.indexOf('@scope/fake-root') < stdout.indexOf('fake-alias'),
      'the aliases must be published after the service',
    );
    assert.ok(
      stdout.indexOf('@scope/fake-root') < stdout.indexOf('fake-run-alias'),
      'the aliases must be published after the service',
    );

    for (const adapter of ['telegram']) {
      const pkg = await readPkg(root, 'packages/chat-plugins', adapter);
      const extension = JSON.parse(await readFile(join(root, 'packages/chat-plugins', adapter, 'cezar-extension.json'), 'utf8'));
      assert.equal(pkg.version, '0.1.0');
      assert.equal(extension.version, pkg.version, 'npm installation requires matching artifact and extension versions');
      assert.deepEqual(pkg.dependencies, { '@scope/fake-sdk': '^0.1.0' });
    }

    const clientPkg = await readPkg(root, 'packages', 'api-client');
    const cezarPkg = await readPkg(root, 'packages', 'cezar');
    const aliasPkg = await readPkg(root, 'alias-cezar');
    assert.equal(clientPkg.version, '0.1.6');
    assert.equal(cezarPkg.version, '0.1.6');
    assert.equal(aliasPkg.version, '0.1.6');
    // Caret, not an exact pin — the stable-release contract, on both edges.
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '^0.1.6' });
    const runAliasPkg = await readPkg(root, 'alias-cezar-run');
    assert.equal(runAliasPkg.version, '0.1.6');
    assert.deepEqual(runAliasPkg.dependencies, { '@scope/fake-root': '^0.1.6' });
    assert.deepEqual(cezarPkg.devDependencies, { '@scope/fake-client': '^0.1.6' });

    // The workspace root publishes nothing and must be left exactly as it was.
    const rootPkg = await readPkg(root);
    assert.equal(rootPkg.version, '0.0.0');

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=0\.1\.6$/m);
    assert.match(output, /^published=false$/m);
    assert.match(output, /^dryRun=true$/m);
    // The release notes' install command reads this output.
    assert.match(output, /^runAliasName=fake-run-alias$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a private package is stamped but never published', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    // Mark the client private, the way the api-client is until its contract stops moving.
    const clientPath = join(root, 'packages', 'api-client', 'package.json');
    const clientPkg = JSON.parse(await readFile(clientPath, 'utf8')) as Record<string, unknown>;
    await writeFile(clientPath, `${JSON.stringify({ ...clientPkg, private: true }, null, 2)}\n`);

    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);

    // Stamped in lockstep — a frozen version would strand the service's pin against it.
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.1.6');
    assert.deepEqual((await readPkg(root, 'packages', 'cezar')).devDependencies, {
      '@scope/fake-client': '^0.1.6',
    });

    // …but never handed to npm, and the skip is stated rather than silent.
    assert.match(stdout, /@scope\/fake-client is private — stamped to 0\.1\.6, not published/);
    assert.ok(
      !/npm publish[^\n]*\(@scope\/fake-client\)/.test(stdout),
      'a private package must not be published',
    );
    // The rest still publish.
    assert.match(stdout, /\(@scope\/fake-root\)/);
    assert.match(stdout, /\(fake-alias\)/);
    assert.match(stdout, /\(fake-run-alias\)/);

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^publishedNames=@scope\/fake-sdk,@scope\/fake-telegram,@scope\/fake-root,fake-alias,fake-run-alias$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the existing bump publishes the committed version verbatim', { timeout: 120_000 }, async () => {
  const root = await makeFixture('2.3.4');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, ['existing', '--dry-run']);
    assert.equal((await readPkg(root, 'packages', 'cezar')).version, '2.3.4');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=2\.3\.4$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing NPM token forces a dry run instead of publishing', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    // No --dry-run flag and no NODE_AUTH_TOKEN: the script must degrade, not publish.
    const { stdout } = await runScript(root, ['minor']);
    assert.match(stdout, /forcing --dry-run/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^published=false$/m);
    assert.match(output, /^version=0\.2\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown bump exits non-zero without touching the manifests', { timeout: 60_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await assert.rejects(runScript(root, ['snapshot', '--dry-run']));
    assert.equal((await readPkg(root, 'packages', 'cezar')).version, '0.1.5');
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.1.5');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--dist-tag publishes an older line without moving latest', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['existing', '--dist-tag', 'latest-0.1', '--dry-run']);
    assert.match(stdout, /dist-tag latest-0\.1/);
    assert.ok(!/--tag latest(\s|$)/m.test(stdout), 'must not publish under latest');
    assert.match(await readFile(join(root, 'github-output.txt'), 'utf8'), /^distTag=latest-0\.1$/m);
    await assert.rejects(runScript(root, ['existing', '--dist-tag', '1.2.3', '--dry-run']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent publication is idempotent and rebuilds stamped inputs before publishing', { timeout: 30_000 }, async () => {
  const root = await makeFixture('0.20.0');
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'synthetic build' } }));
    const npm = join(root, 'fake-npm.cjs');
    await writeFile(npm, `
      const fs = require('node:fs'); const path = require('node:path');
      const root = ${JSON.stringify(root)};
      const args = process.argv.slice(2);
      const statePath = path.join(root, 'registry-state.json');
      const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { '@scope/fake-telegram@0.1.0': true };
      const log = (s) => fs.appendFileSync(path.join(root, 'npm.log'), s + '\\n');
      if (args[0] === 'view') {
        log('view ' + args[1]);
        if (!state[args[1]]) { console.error('E404'); process.exit(1); }
        console.log(args[1].slice(args[1].lastIndexOf('@') + 1));
      } else if (args[0] === 'run') {
        for (const provider of ['telegram']) {
          const dir = path.join(root, 'packages/chat-plugins', provider);
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
          const ext = JSON.parse(fs.readFileSync(path.join(dir, 'cezar-extension.json')));
          if (pkg.version !== ext.version) throw Error('installation invariant');
          log('built ' + pkg.name + '@' + ext.version);
        }
      } else if (args[0] === 'publish') {
        const pkg = JSON.parse(fs.readFileSync('package.json'));
        const id = pkg.name + '@' + pkg.version;
        if (state[id]) throw Error('duplicate publish');
        log('publish ' + id); state[id] = true;
        fs.writeFileSync(statePath, JSON.stringify(state));
      } else { throw Error('unexpected npm command: ' + args); }
    `);
    const env = { NODE_AUTH_TOKEN: 'synthetic-only', npm_execpath: npm };
    await runScript(root, ['patch', '--reconcile-tag'], env);
    const first = await readFile(join(root, 'npm.log'), 'utf8');
    assert.match(first, /view @scope\/fake-telegram@0\.1\.0/);
    assert.doesNotMatch(first, /publish @scope\/fake-telegram/);
    assert.ok(first.indexOf('built @scope/fake-telegram@0.1.0') < first.indexOf('publish @scope/fake-sdk@0.20.1'));
    await runScript(root, ['existing'], env);
    const second = await readFile(join(root, 'npm.log'), 'utf8');
    assert.equal(second.match(/^publish /gm)?.length, first.match(/^publish /gm)?.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a mismatched adapter manifest stops before stamping or publishing', { timeout: 30_000 }, async () => {
  const root = await makeFixture('0.20.0');
  try {
    await writeFile(join(root, 'packages/chat-plugins/telegram/cezar-extension.json'), JSON.stringify({ version: '9.9.9' }));
    await assert.rejects(runScript(root, ['patch', '--dry-run']), /versions disagree/);
    assert.equal((await readPkg(root, 'packages/cezar')).version, '0.20.0');
    assert.equal((await readPkg(root, 'packages/chat-plugins/telegram')).version, '0.1.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});
