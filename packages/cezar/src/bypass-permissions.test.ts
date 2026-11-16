import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BYPASS_PERMISSIONS_ROOT, BYPASS_PERMISSIONS_TRACKED, bypassPermissionsBlocked } from './bypass-permissions.ts';

describe('bypassPermissionsBlocked', () => {
  let repoRoot: string;
  const ON = { bypassPermissions: true };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-bypass-blocked-'));
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify(ON));
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('says nothing when the setting is off', async () => {
    expect(await bypassPermissionsBlocked(repoRoot, {}, 0)).toBeNull();
  });

  it('honors a local, untracked config for a regular user', async () => {
    expect(await bypassPermissionsBlocked(repoRoot, ON, 501)).toBeNull();
  });

  // Claude Code exits on bypass mode as root: every task would fail instead of asking.
  it('is off for root', async () => {
    expect(await bypassPermissionsBlocked(repoRoot, ON, 0)).toBe(BYPASS_PERMISSIONS_ROOT);
  });

  it('is off while config.json is tracked by git', async () => {
    execFileSync('git', ['add', '-f', '.ai/cezar/config.json'], { cwd: repoRoot });
    expect(await bypassPermissionsBlocked(repoRoot, ON, 501)).toBe(BYPASS_PERMISSIONS_TRACKED);
  });
});
