// The relay vectors are a frozen contract (BACKWARD_COMPATIBILITY.md §6c) with no consumer until R3.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const vectors = fileURLToPath(new URL('../../../../test-vectors/relay/', import.meta.url));
const run = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, [join(vectors, script), ...args], { encoding: 'utf8' });
const jsonFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.json')).sort();

const regenerated = mkdtempSync(join(tmpdir(), 'relay-vectors-'));
after(() => rmSync(regenerated, { recursive: true, force: true }));

test('the independent check passes on the committed vectors', () => {
  assert.match(run('verify.mjs'), /checks passed/);
});

test('the Noise state machine passes the published vectors', () => {
  assert.match(run('generator/check-published.mjs'), /published: 5 vectors/);
});

test('regenerating reproduces every committed byte', () => {
  run('generator/generate.mjs', regenerated);
  assert.deepEqual(jsonFiles(regenerated), jsonFiles(vectors));
  for (const name of jsonFiles(vectors)) {
    assert.ok(readFileSync(join(regenerated, name)).equals(readFileSync(join(vectors, name))), `${name} drifted`);
  }
});
