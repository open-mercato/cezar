import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Run from inside a cezar task, tmpdir() used to sit in the user's checkout, and the "non-repo"
// git cases committed and pushed there. vitest.setup.ts moves it out; this pins that.
it('a fresh tmpdir() folder is outside every git work tree, so no fixture can reach a real checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-isolation-'));
  try {
    const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
    expect(probe.status, `tmpdir ${dir} is inside the work tree ${probe.stdout.trim()}`).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('tmpdir() is writable so fixtures and sandbox directories can be allocated', () => {
  expect(() => accessSync(tmpdir(), constants.W_OK)).not.toThrow();
});
