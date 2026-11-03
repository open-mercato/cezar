import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { detectVerifyCommands, parseStructured, proposeWorkflowName } from '../../src/planner.js';

test('proposeWorkflowName slugs a title to the file-name form', () => {
  assert.equal(proposeWorkflowName('Fix And Review'), 'fix-and-review');
  assert.equal(proposeWorkflowName('  Ship it!  '), 'ship-it');
  assert.equal(proposeWorkflowName('already-kebab'), 'already-kebab');
});

test('proposeWorkflowName degrades a blank / slug-less title to undefined', () => {
  // The caller keeps the current name rather than blanking it when nothing survives.
  assert.equal(proposeWorkflowName(undefined), undefined);
  assert.equal(proposeWorkflowName('   '), undefined);
  assert.equal(proposeWorkflowName('!!! ???'), undefined);
});

test('parseStructured reads the optional planner title alongside the steps', () => {
  const schema = z.object({
    title: z.string().optional(),
    steps: z.array(z.object({ name: z.string() })),
  });
  const parsed = parseStructured(
    '```json\n{"title":"fix-and-review","steps":[{"name":"Implement"}]}\n```',
    schema,
  );
  assert.deepEqual(parsed, { title: 'fix-and-review', steps: [{ name: 'Implement' }] });
});

test('detectVerifyCommands offers the repo\'s end-to-end suite, after the cheap checks', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-planner-detect-'));
  try {
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', 'test:e2e': 'e2e run' } }),
    );

    // The script is the project's own answer for how to run its suite — whichever
    // framework it is — and it comes last: a browser run is the slowest check and
    // the only one that can cost model calls, so a chain reaches it once unit
    // tests are green.
    assert.deepEqual(await detectVerifyCommands(repoRoot), ['npm test', 'npm run test:e2e']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectVerifyCommands falls back to `npx e2e run` on a config with no script', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-planner-detect-cfg-'));
  try {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    writeFileSync(join(repoRoot, 'e2e.config.ts'), 'export default {};\n');

    assert.deepEqual(await detectVerifyCommands(repoRoot), ['npm run lint', 'npx e2e run']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectVerifyCommands names nothing when the repo has no suite', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-planner-detect-none-'));
  try {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: {} }));
    assert.deepEqual(await detectVerifyCommands(repoRoot), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
