import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('real vendored runtime buffers', () => {
  let root: string;
  let cwd: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const runtime = (op: string, ...args: string[]) => spawnSync(process.execPath, [script, op, '--worktree', cwd, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-runtime-buffers-'));
    cwd = join(root, 'repo');
    mkdirSync(cwd);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(cwd, 'file.txt'), 'base\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const captureAndStage = () => {
    git('add', '.');
    git('commit', '-qm', 'base');
    const start = join(root, 'start.json');
    expect(runtime('capture', '--output', start).status).toBe(0);
    writeFileSync(join(cwd, 'file.txt'), 'changed\n');
    const paths = join(root, 'paths.txt');
    writeFileSync(paths, 'file.txt\n');
    const staged = runtime('stage', '--start-state', start, '--paths-file', paths);
    expect(staged.status, staged.stderr.slice(-300)).toBe(0);
    expect(JSON.parse(staged.stdout)).toMatchObject({ status: 'ready', stagedPaths: ['file.txt'] });
    expect(git('diff', '--cached', '--name-only')).toBe('file.txt\n');
  };

  it('[round2-1] captures and stages when the tracked path list exceeds one MiB', () => {
    for (let i = 0; i < 7_000; i += 1) writeFileSync(join(cwd, `${String(i).padStart(5, '0')}-${'x'.repeat(235)}`), '');
    git('add', '.');
    expect(Buffer.byteLength(git('ls-files', '-z'))).toBeGreaterThan(1024 * 1024);
    captureAndStage();
  }, 30_000);

  it('[round2-1] prepares review from a worktree diff larger than one MiB', () => {
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(cwd, 'file.txt'), `${'lockfile entry\n'.repeat(100_000)}`);
    const config = join(root, 'config.json');
    // A reviewer-less profile runs only the review subject builder.
    writeFileSync(config, JSON.stringify({ agentHarness: { version: 1, delivery: { mode: 'stage-only' }, models: {}, profiles: { subject: { reviewers: [] } } } }));
    const result = runtime('review', '--config', config, '--profile', 'subject', '--output-dir', join(root, 'review-out'));
    expect(result.status, result.stderr.slice(-300)).toBe(0);
    const expected = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd, maxBuffer: 256 * 1024 * 1024 });
    expect(expected.length).toBeGreaterThan(1024 * 1024);
    const review = JSON.parse(readFileSync(JSON.parse(result.stdout).jsonPath, 'utf8'));
    expect(review.reviewContract.subjectSha256).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('guard: a small repository captures and stages the same exact handoff', () => captureAndStage());
});
