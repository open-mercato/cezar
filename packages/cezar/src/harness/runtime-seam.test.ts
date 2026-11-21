import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir } from '../git-pin.js';
import { resetIndexToHead } from './driver.js';
import { advisorCouncilResultMaxBytes } from './prompt-budget.js';
import { HarnessRuntime } from './runtime.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('runtime seam', () => {
  let root: string;
  let cwd: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const runtime = (op: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { cwd, encoding: 'utf8' }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-round3-'));
    cwd = join(root, 'repo');
    mkdirSync(join(cwd, 'src/nested'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'base\n');
    writeFileSync(join(cwd, 'other.txt'), 'other\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    pinWorktreeGitDir(cwd, join(cwd, '.git'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const reviewerConfig = () => ({
    agentHarness: {
      version: 1,
      delivery: { mode: 'stage-only' },
      models: {
        codex: {
          adapter: 'command', family: 'openai', model: 'test-model',
          roles: ['reviewer'], reasoningEffort: 'high',
          commands: { review: ['codex', 'exec', '--sandbox', 'read-only', '-'] },
        },
      },
      profiles: { multi: { reviewers: ['codex'] } },
    },
  });

  const validateConfig = (config: unknown) => {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    return runtime('validate-config', '--config', path);
  };

  it('validates reviewer adapters without configured workers', () => {
    expect(validateConfig(reviewerConfig())).toMatchObject({ status: 'valid', models: ['codex'] });
  });

  it('rejects worker bindings instead of advertising an adapter it cannot execute', () => {
    const config = reviewerConfig();
    Object.assign(config.agentHarness.models.codex, {
      roles: ['reviewer', 'worker'],
      workerSecurity: {
        network: 'disabled', remoteWrites: 'disabled', refWrites: 'disabled',
        enforcedBy: 'codex-workspace-write-sandbox',
      },
    });
    Object.assign(config.agentHarness.models.codex.commands, {
      worker: ['codex', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
        '--config', 'model_reasoning_effort={reasoningEffort}', '--sandbox', 'workspace-write',
        '--cd', '{worktree}', '--model', '{model}', '-'],
    });
    expect(() => validateConfig(config)).toThrow(/reviewer-only/);
  });

  it.each(['workers', 'concurrency', 'packetPolicy'])('rejects the unused %s profile setting', (field) => {
    const config = reviewerConfig();
    Object.assign(config.agentHarness.profiles.multi, {
      [field]: field === 'workers' ? [] : field === 'concurrency' ? { reviewers: 1 } : {},
    });
    expect(() => validateConfig(config)).toThrow(/unsupported setting/);
  });

  it('[round3-1] refuses to spawn a real runtime op after kill', async () => {
    const bridge = new HarnessRuntime({ script, cwd });
    const onSpawn = vi.fn();
    const output = join(root, 'cancelled-capture.json');
    bridge.kill();
    const result = await bridge.run('capture', ['--worktree', cwd, '--output', output], { onSpawn });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: 'op "capture" cancelled', exitCode: null, stdout: '', stderr: '' });
    expect(existsSync(output)).toBe(false);
  });

  it('guard: an uncancelled real runtime still spawns and captures', async () => {
    const bridge = new HarnessRuntime({ script, cwd });
    const onSpawn = vi.fn();
    const output = join(root, 'capture.json');
    expect(await bridge.run('capture', ['--worktree', cwd, '--output', output], { onSpawn })).toMatchObject({ ok: true, exitCode: 0 });
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(existsSync(output)).toBe(true);
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('[round3-3] includes a hidden %s edit in the real staged handoff', (flag) => {
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    git('update-index', flag, 'src/nested/a.txt');
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'hidden worker edit\n');
    expect(git('diff', '--name-only', 'HEAD')).toBe('');
    writeFileSync(join(cwd, 'other.txt'), 'visible worker edit\n');
    resetIndexToHead(cwd);
    const paths = join(root, 'paths.txt');
    writeFileSync(paths, git('diff', '--name-only', 'HEAD'));
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: ['other.txt', 'src/nested/a.txt'] });
    expect(git('diff', '--cached')).toContain('+hidden worker edit');
  });

  it('guard: clearing stale staging keeps the worktree bytes and captured refs', () => {
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'old staged edit\n');
    git('add', 'src/nested/a.txt');
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'final edit\n');
    resetIndexToHead(cwd);
    expect(git('diff', '--cached')).toBe('');
    expect(readFileSync(join(cwd, 'src/nested/a.txt'), 'utf8')).toBe('final edit\n');
    expect(runtime('verify', '--start-state', start)).toMatchObject({ status: 'clean', drift: [] });
  });

});

describe('council result bounds', () => {
  it('[round3-6] derives the result cap from real member budgets and enforces a hard ceiling', () => {
    const small = advisorCouncilResultMaxBytes([{ maxInputBytes: 180_000 }, { maxInputBytes: 180_000 }], 50_000, 10_000);
    expect(small).toBe(17_000_000);
    expect(advisorCouncilResultMaxBytes([{ maxInputBytes: 40_000 }], 50_000, 10_000)).toBeGreaterThan(small);
    expect(advisorCouncilResultMaxBytes([{ maxInputBytes: 1_024 }, {}], 50_000_000, 10_000)).toBe(256 * 1024 * 1024);
  });

  it('guard: small councils retain enough headroom for repeated verbose findings', () => {
    const cap = advisorCouncilResultMaxBytes([{}, {}], 1_000, 10_000);
    expect(cap).toBe(17_000_000);
    expect(cap).toBeGreaterThan(2_000_000);
  });
});
