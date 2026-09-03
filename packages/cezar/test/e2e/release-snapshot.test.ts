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
const script = join(repoRoot, 'scripts', 'release-snapshot.mjs');

// The orchestrator imports packages/cezar/dist/release/snapshot.js, so this suite (like the
// packaged-CLI e2e) runs after `npm run build` — both locally in the gate order
// and in CI's verify job.

/** A miniature of the real workspace: the three publishable manifests, in their real
 *  directories, with the same intra-release dependency edges the pipeline has to re-pin. */
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-release-snapshot-'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fake-monorepo', private: true, version: '0.0.0' }, null, 2)}\n`,
  );

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
    `${JSON.stringify({ name: '@scope/fake-client', version: '0.9.9', files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'api-client', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'cezar'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'cezar', 'package.json'),
    `${JSON.stringify(
      {
        name: '@scope/fake-root',
        version: '0.9.9',
        files: ['index.js'],
        devDependencies: { '@scope/fake-client': '^0.9.9' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'packages', 'cezar', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'alias-cezar'));
  await writeFile(
    join(root, 'alias-cezar', 'package.json'),
    `${JSON.stringify(
      {
        name: 'fake-alias',
        version: '0.9.9',
        files: ['bin.js'],
        dependencies: { '@scope/fake-root': '^0.9.9' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'alias-cezar', 'bin.js'), '#!/usr/bin/env node\n');
  return root;
}

const readPkg = async (root: string, ...segments: string[]) =>
  JSON.parse(await readFile(join(root, ...segments, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

function runScript(fixtureRoot: string, extraEnv: Record<string, string>, args: string[] = []) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CEZ_SNAPSHOT_ROOT: fixtureRoot,
    GITHUB_OUTPUT: join(fixtureRoot, 'github-output.txt'),
    NODE_AUTH_TOKEN: '',
    GITHUB_ACTIONS: '',
    // Neutralized for the same reason as the two above: the suite inherits `process.env`, and
    // under Actions that carries the workflow's OWN run identity. `GITHUB_RUN_ATTEMPT` is the
    // one that bites, because `computeSnapshot` appends `.${attempt}` whenever it is > 1 — so
    // on a re-run (attempt 2+) every version the orchestrator stamps here silently grew a
    // suffix and the hard-coded expectations below missed by it. Pinning the default to the
    // first attempt makes the suite depend only on what each test passes; a test that wants to
    // exercise re-run behavior overrides it explicitly via `extraEnv`.
    GITHUB_RUN_ATTEMPT: '1',
    ...extraEnv,
  };
  return execFile(process.execPath, [script, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
}

test('dry-run publish stamps every manifest, pins each sibling exact, and emits the result JSON', { timeout: 120_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(
      root,
      {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_NUMBER: '77',
        PR_HEAD_REPO: 'open-mercato/cezar',
        GITHUB_REPOSITORY: 'open-mercato/cezar',
        GITHUB_RUN_NUMBER: '5',
        GITHUB_RUN_ATTEMPT: '1',
      },
      ['--dry-run'],
    );

    const clientPkg = await readPkg(root, 'packages', 'api-client');
    const cezarPkg = await readPkg(root, 'packages', 'cezar');
    const aliasPkg = await readPkg(root, 'alias-cezar');
    assert.equal(clientPkg.version, '0.9.9-pr77.5');
    assert.equal(cezarPkg.version, '0.9.9-pr77.5');
    assert.equal(aliasPkg.version, '0.9.9-pr77.5');
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '0.9.9-pr77.5' });
    assert.deepEqual(cezarPkg.devDependencies, { '@scope/fake-client': '0.9.9-pr77.5' });
    // The workspace root publishes nothing and must be left exactly as it was.
    assert.equal((await readPkg(root)).version, '0.0.0');

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^attempted=true$/m);
    assert.match(output, /^dryRun=true$/m);
    const resultLine = output.split('\n').find((line) => line.startsWith('result='));
    assert.ok(resultLine, 'GITHUB_OUTPUT should carry the result JSON');
    const result = JSON.parse(resultLine.slice('result='.length)) as {
      distTag: string;
      installLines: string[];
    };
    assert.equal(result.distTag, 'pr-77');
    assert.ok(
      result.installLines.some((line) => line.includes('npx fake-alias@0.9.9-pr77.5')),
      'install lines should use the actual alias name and exact version',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing NPM token forces a dry run instead of failing the job', { timeout: 120_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    // No --dry-run flag and no NODE_AUTH_TOKEN: the script must degrade, not throw.
    const { stdout } = await runScript(root, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'develop',
      GITHUB_REPOSITORY: 'open-mercato/cezar',
      GITHUB_RUN_NUMBER: '8',
    });
    assert.match(stdout, /forcing --dry-run/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^dryRun=true$/m);
    assert.match(output, /"distTag":"develop"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the nightly channel stamps a dated version and publishes under the nightly tag', { timeout: 120_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(
      root,
      {
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_REF_NAME: 'main',
        GITHUB_REPOSITORY: 'open-mercato/cezar',
        GITHUB_RUN_NUMBER: '12',
        CEZ_RELEASE_CHANNEL: 'nightly',
        // Pinned so the assertion below is not a race with the wall clock.
        NIGHTLY_DATE: '20260813',
      },
      ['--dry-run'],
    );

    const aliasPkg = await readPkg(root, 'alias-cezar');
    assert.equal(aliasPkg.version, '0.9.9-nightly.20260813.12');
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '0.9.9-nightly.20260813.12' });
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^attempted=true$/m);
    assert.match(output, /"distTag":"nightly"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The other half of the contract the pinned default above protects: an attempt number the test
// asks for still reaches the orchestrator and still separates a re-cut from the original, so
// re-running a nightly cannot try to publish a version npm already has. Passing it explicitly
// also proves the default is a default and not a hard override.
test('a nightly re-run stamps the attempt onto the version so it cannot collide', { timeout: 120_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(
      root,
      {
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_REF_NAME: 'main',
        GITHUB_REPOSITORY: 'open-mercato/cezar',
        GITHUB_RUN_NUMBER: '12',
        GITHUB_RUN_ATTEMPT: '2',
        CEZ_RELEASE_CHANNEL: 'nightly',
        NIGHTLY_DATE: '20260813',
      },
      ['--dry-run'],
    );

    const aliasPkg = await readPkg(root, 'alias-cezar');
    assert.equal(aliasPkg.version, '0.9.9-nightly.20260813.12.2');
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '0.9.9-nightly.20260813.12.2' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same schedule event without the channel request publishes nothing', { timeout: 60_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'open-mercato/cezar',
      GITHUB_RUN_NUMBER: '13',
    });
    assert.equal((await readPkg(root, 'packages', 'cezar')).version, '0.9.9');
    assert.match(await readFile(join(root, 'github-output.txt'), 'utf8'), /^attempted=false$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-publishable event exits 0 without touching the manifests', { timeout: 60_000 }, async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'feat/some-branch',
      GITHUB_REPOSITORY: 'open-mercato/cezar',
      GITHUB_RUN_NUMBER: '9',
    });
    assert.equal((await readPkg(root, 'packages', 'cezar')).version, '0.9.9');
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.9.9');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^attempted=false$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
