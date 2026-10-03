import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchGithub } from './github.ts';

/** A slow `gh` shim, so two calls in one tick genuinely overlap. */
function installSlowGhShim(): { calls: () => string[]; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-gh-slow-'));
  const log = join(dir, 'calls.log');
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`
      + `case "$*" in\n`
      + `  *"repo view"*) sleep 0.3; printf '%s' 'acme/demo' ;;\n`
      + `  *) printf '%s' '[]' ;;\n`
      + `esac\n`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ''}`;
  return {
    calls: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    restore: () => {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('fetchGithub single-flight', () => {
  it('two concurrent cold reads share one set of gh spawns', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-gh-slow-cwd-'));
    const shim = installSlowGhShim();
    try {
      await Promise.all([fetchGithub(cwd, false, 30), fetchGithub(cwd, false, 30)]);
      const repoViews = shim.calls().filter((line) => line.includes('repo view'));
      expect(repoViews).toHaveLength(1);
    } finally {
      shim.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
