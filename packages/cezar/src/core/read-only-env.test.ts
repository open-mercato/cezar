import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { opencodeReadOnlyConfig } from './private-mcp.ts';
import { readOnlyEnv } from './read-only-env.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('readOnlyEnv', () => {
  it('leaves gh with no login', () => {
    const env = readOnlyEnv();
    expect(env.GH_TOKEN).toBe('');
    expect(env.GITHUB_TOKEN).toBe('');
    expect(env.GH_CONFIG_DIR).toBeTruthy();
  });

  it('makes git fail to reach an ssh remote', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-ro-'));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    git('remote', 'add', 'origin', 'git@github.invalid:o/r.git');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, env: { ...process.env, ...readOnlyEnv() }, encoding: 'utf8' });
    expect(push.status).not.toBe(0);
  });
});

describe('opencodeReadOnlyConfig', () => {
  it('denies edits and the shell over whatever the host config granted', () => {
    const config = JSON.parse(opencodeReadOnlyConfig('{"mcp":{"a":1},"permission":{"bash":"allow"}}'));
    expect(config.permission).toEqual({ edit: 'deny', bash: 'deny' });
    expect(config.mcp).toEqual({ a: 1 });
  });

  it('still denies when the host value cannot be read', () => {
    expect(JSON.parse(opencodeReadOnlyConfig('not json')).permission.bash).toBe('deny');
  });
});
