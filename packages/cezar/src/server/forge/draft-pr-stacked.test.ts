import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftPr } from './github.ts';
import type { RunRecord } from '../../runs/store.ts';

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd, encoding: 'utf8' });

// A task started from another task's branch stacks its PR on the parent's open PR (#1759).
describe('createDraftPr stacked base (#1759)', () => {
  let dir: string;
  let remote: string;
  let bin: string;
  const calls = () => readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n').filter(Boolean);
  const createCall = () => calls().find((c) => c.startsWith('pr create')) ?? '';
  const publish = (extra: Partial<RunRecord> = {}, input: { updateExisting?: boolean } = {}) =>
    createDraftPr({
      repoRoot: dir,
      handoffText: '# Goal\n',
      ...input,
      run: {
        worktreePath: dir, branch: 'cez/child', baseBranch: 'cez/parent', task: 't', title: 't',
        pullRequestUrl: 'https://github.com/o/r/pull/9', ...extra,
      } as RunRecord,
    });
  const setParent = (json: string) => writeFileSync(join(bin, 'parent'), json);

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'cez-st-remote-'));
    dir = mkdtempSync(join(tmpdir(), 'cez-st-'));
    bin = mkdtempSync(join(tmpdir(), 'cez-st-bin-'));
    execFileSync('git', ['init', '--bare', '-q', remote]);
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'base');
    g(dir, 'remote', 'add', 'origin', remote);
    g(dir, 'push', '-q', 'origin', 'main');
    g(dir, 'checkout', '-q', '-b', 'cez/parent');
    writeFileSync(join(dir, 'p.txt'), 'p\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'parent');
    g(dir, 'push', '-q', 'origin', 'cez/parent');
    g(dir, 'checkout', '-q', '-b', 'cez/child');
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'child');
    writeFileSync(join(bin, 'calls'), '');
    setParent('[]');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
echo "$*" >> "${bin}/calls"
case "$1 $2" in
  "pr create") echo https://github.com/o/r/pull/9;;
  "pr list") case "$*" in *cez/parent*) cat "${bin}/parent";; *) echo '[]';; esac;;
  "pr view") echo '{"baseRefName":"cez/parent","state":"OPEN"}';;
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}';;
  "pr edit") ;;
  *) exit 1;;
esac
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('CEZ_DRY_RUN', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [dir, remote, bin]) rmSync(d, { recursive: true, force: true });
  });

  it('targets the parent branch while its PR is open', async () => {
    setParent('[{"state":"OPEN"}]');
    const out = await publish({ pullRequestUrl: undefined });
    expect(out.ok).toBe(true);
    expect(createCall()).toContain('--base cez/parent');
  });

  it('falls back to the repo default when the parent has no PR', async () => {
    const out = await publish({ pullRequestUrl: undefined });
    expect(out.ok).toBe(true);
    expect(createCall()).not.toContain('--base');
  });

  it('falls back to the repo default when the parent PR merged or closed', async () => {
    for (const state of ['MERGED', 'CLOSED']) {
      setParent(`[{"state":"${state}"}]`);
      writeFileSync(join(bin, 'calls'), '');
      await publish({ pullRequestUrl: undefined });
      expect(createCall()).not.toContain('--base');
    }
  });

  it('falls back when gh output is not what the schema expects', async () => {
    setParent('{"nope":1}');
    await publish({ pullRequestUrl: undefined });
    expect(createCall()).not.toContain('--base');
  });

  it('keeps a non-task base (develop) untouched and asks no parent question', async () => {
    await publish({ pullRequestUrl: undefined, baseBranch: 'develop' });
    expect(createCall()).toContain('--base develop');
    expect(calls().some((c) => c.startsWith('pr list') && c.includes('--head develop'))).toBe(false);
  });

  it('retargets the child PR to the default branch once the parent PR merged', async () => {
    setParent('[{"state":"MERGED"}]');
    const out = await publish({}, { updateExisting: true });
    expect(out).toMatchObject({ ok: true, updated: true });
    expect(calls()).toContain('pr edit https://github.com/o/r/pull/9 --base main');
  });

  it('does not retarget while the parent PR is still open', async () => {
    setParent('[{"state":"OPEN"}]');
    await publish({}, { updateExisting: true });
    expect(calls().some((c) => c.startsWith('pr edit'))).toBe(false);
  });
});
