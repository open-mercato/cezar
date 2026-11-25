import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { REVIEW_PR } from './templates.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ launches: [] as Array<{ backend: string; spec: AgentRunSpec }> }));

// A capture stub: the backend refusal itself is `read-only-env.test.ts`'s business.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.launches.push({ backend, spec });
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId: `sess-${captured.launches.length}` });
            const text = 'ok\n\nCEZ:VERDICT approve';
            onEvent?.({ type: 'text', text });
            onEvent?.({ type: 'turn-end' });
            resolve({ text, toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

/** The read-only `review-pr` workflow keeps its tool limits on every launch, or does not launch. */
describe('a read-only workflow', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.launches.length = 0;
    // No `gh` call to github.com from a unit test: the checkout reads git alone.
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-read-only-workflow-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), JSON.stringify({ mcpServers: { tracker: { command: 'tracker-mcp' } } }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const terminal = (id: string) =>
    vi.waitFor(() => expect(['done', 'review', 'failed', 'cancelled']).toContain(store.getRun(id)?.status), { timeout: 20_000 });

  it('launches on Claude with a read-only shell and no private MCP', async () => {
    manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' });
    await vi.waitFor(() => expect(captured.launches.length).toBeGreaterThan(0), { timeout: 15_000 });
    const { spec } = captured.launches[0]!;
    expect(spec.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(spec.bashAllowlist).toContain('gh pr diff');
    expect(spec.bashAllowlist).not.toContain('git push');
    expect(spec.mcpServers).toEqual([]);
  });

  it('checks the PR out before any reviewer, then reviewers only read files', async () => {
    // A local origin carrying refs/pull/1/head, as GitHub does.
    const origin = mkdtempSync(join(tmpdir(), 'cez-read-only-origin-'));
    try {
      await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      await run('git', ['remote', 'add', 'origin', origin], { cwd: repoRoot });
      await run('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoRoot });
      await run('git', ['checkout', '-q', '-b', 'pr'], { cwd: repoRoot });
      writeFileSync(join(repoRoot, 'a.txt'), 'one\nfrom the PR\n');
      await run('git', [...GIT_ID, 'commit', '-qam', 'pr change'], { cwd: repoRoot });
      const prSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
      await run('git', ['push', '-q', 'origin', 'HEAD:refs/pull/1/head'], { cwd: repoRoot });
      await run('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
      await run('git', ['branch', '-q', '-D', 'pr'], { cwd: repoRoot });

      const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' }).id;
      await terminal(id);
      const record = store.getRun(id)!;
      expect(record.status, record.error).not.toBe('failed');
      const launches = captured.launches.filter((l) => l.spec.cwd === record.worktreePath);
      expect(launches).toHaveLength(4);
      const artifacts = join(repoRoot, '.ai/cezar/artifacts', id);
      expect(readFileSync(join(artifacts, 'pr-1.diff'), 'utf8')).toContain('+from the PR');
      for (const { spec } of launches) {
        // The worktree holds the PR before the first reviewer starts, and every prompt names its files.
        expect(spec.userPrompt).toContain('checked out into this worktree: yes');
        expect(spec.userPrompt).toContain(join(artifacts, 'pr-1.diff'));
        expect(spec.artifactsWriteDir).toBe(artifacts);
        expect(spec.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
        expect(spec.bashAllowlist).not.toContain('git push');
      }
      expect((await run('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath! })).stdout.trim()).toBe(prSha);
      // Nothing was pushed: origin's only PR ref is the one the test made.
      expect((await run('git', ['ls-remote', origin])).stdout).not.toContain(record.branch!);
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });

  it('still reviews when the checkout fails, through the gh fallback', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' }).id;
    await terminal(id);
    const record = store.getRun(id)!;
    expect(record.status, record.error).not.toBe('failed');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('no git remote');
    const launches = captured.launches.filter((l) => l.spec.cwd === record.worktreePath);
    expect(launches).toHaveLength(4);
    for (const { spec } of launches) {
      expect(spec.userPrompt).toContain('checked out into this worktree: no');
      expect(spec.bashAllowlist).toEqual(expect.arrayContaining(['gh pr view', 'gh pr diff']));
    }
  });

  it('passes the owning step limits to isolated Codex on launch and Continue', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'codex' }).id;
    await terminal(id);
    expect(store.getRun(id)?.status, store.getRun(id)?.error).not.toBe('failed');
    const before = captured.launches.filter(l => l.backend === 'codex').length;
    manager!.continueRun(id, { text: 'now push it', runner: 'codex' });
    await vi.waitFor(() => expect(captured.launches.filter(l => l.backend === 'codex').length).toBeGreaterThan(before), { timeout: 15_000 });
    await terminal(id);
    const launches = captured.launches.filter(l => l.backend === 'codex');
    expect(launches.length).toBeGreaterThan(1);
    for (const { spec } of launches) {
      expect(spec.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
      expect(spec.bashAllowlist).toContain('gh pr diff');
      expect(spec.bashAllowlist).not.toContain('git push');
      expect(spec.mcpServers).toEqual([]);
    }
  });

  it('refuses a backend that ignores tool limits, before spawning it', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'opencode' }).id;
    await terminal(id);
    // By backend: a previous case's disposed run may still land a late launch of its own.
    expect(captured.launches.filter((l) => l.backend === 'opencode')).toEqual([]);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('opencode does not enforce');
  });

  it('refuses a Continue on such a backend too', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' }).id;
    await terminal(id);
    manager!.continueRun(id, { text: 'now push it', runner: 'opencode' });
    await vi.waitFor(() => expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('opencode does not enforce'), { timeout: 15_000 });
    expect(captured.launches.filter((l) => l.backend === 'opencode')).toEqual([]);
  });
});
