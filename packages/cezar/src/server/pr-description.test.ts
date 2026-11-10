import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunner, AgentRunSpec } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';
import { buildPrBody } from './forge/github.ts';
import {
  composePrDescription,
  describePr,
  prDescriptionActive,
  recordPrDescribeUsage,
  type DescribePrDeps,
} from './pr-description.ts';

const HANDOFF = '## Goal\n\nmake login faster\n\n## Progress log\n\n- 10:00 cached the session\n';

const run = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: 'r1',
    title: 'make login faster',
    task: 'make login faster please',
    worktreePath: '/wt',
    branch: 'cez/r1',
    baseBranch: 'main',
    runner: 'claude',
    model: 'opus',
    steps: [
      { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 100, costUsd: 0.5, backend: 'claude' },
      { id: 'tests', name: 'npm test', kind: 'check', status: 'done', iterations: 1, tokensUsed: 0 },
      { id: 'lint', name: 'npm run lint', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0 },
    ],
    ...over,
  }) as unknown as RunRecord;

const ANSWER = JSON.stringify({
  title: 'perf(auth): cache the login session',
  summary: 'Login reuses a cached session instead of re-reading it.',
  changes: [{ area: 'auth', items: ['cache the session in memory'] }],
  changelog: 'Login is faster.',
});

const fakeRunner = (behave: (spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void) => Promise<{ text: string }>) => {
  const specs: AgentRunSpec[] = [];
  const interrupt = vi.fn(async () => {});
  const runner = {
    backend: 'claude',
    run: async (spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void) => {
      specs.push(spec);
      const { text } = await behave(spec, onEvent);
      return { text, toolCalls: [], tokensUsed: 42 };
    },
    startSession: () => {
      throw new Error('unused');
    },
    interrupt,
  } as unknown as AgentRunner;
  return { runner, specs, interrupt };
};

const deps = (runner: AgentRunner, over: Partial<DescribePrDeps> = {}): DescribePrDeps => ({
  createRunner: () => runner,
  profileEnv: async () => ({ ACCOUNT: 'work' }),
  diff: async () => ({ files: [{ path: 'src/auth.ts', added: 3, removed: 1 }], patch: '+cache\n', truncated: false }),
  env: {},
  ...over,
});

const fallback = { title: 'make login faster', body: buildPrBody(HANDOFF, 'make login faster please'), generated: false };

describe('generated PR description (#1757)', () => {
  it('is on by default, off under CEZ_PR_DESCRIBE=0 and CEZ_DRY_RUN=1', () => {
    expect(prDescriptionActive({})).toBe(true);
    expect(prDescriptionActive({ CEZ_PR_DESCRIBE: '0' })).toBe(false);
    expect(prDescriptionActive({ CEZ_DRY_RUN: '1' })).toBe(false);
  });

  it('composes the sections, listing only the checks that passed', () => {
    const composed = composePrDescription(ANSWER, ['npm test']);
    expect(composed?.title).toBe('perf(auth): cache the login session');
    expect(composed?.body).toBe(
      [
        '## Summary', '', 'Login reuses a cached session instead of re-reading it.', '',
        '## Changes', '', '### auth', '', '- cache the session in memory', '',
        '## Verification', '', '- [x] npm test', '',
        '## Changelog', '', 'Login is faster.', '', '---', '', '🤖 made with cezar',
      ].join('\n'),
    );
    expect(composePrDescription(ANSWER, [])?.body).not.toContain('## Verification');
  });

  it('rejects a title that is not conventional, and junk', () => {
    expect(composePrDescription(ANSWER.replace('perf(auth): ', ''), [])).toBeNull();
    expect(composePrDescription('not json', [])).toBeNull();
  });

  it("generates on the run's own backend, model and account, and reports the turn's cost", async () => {
    const { runner, specs } = fakeRunner(async (_spec, onEvent) => {
      onEvent?.({ type: 'cost', usd: 0.02 } as AgentEvent);
      return { text: ANSWER };
    });
    const created: string[] = [];
    const draft = await describePr(
      { repoRoot: '/repo', run: run(), handoffText: HANDOFF },
      deps(runner, { createRunner: (id) => (created.push(id), runner) }),
    );
    expect(draft).toMatchObject({ title: 'perf(auth): cache the login session', generated: true, usage: { costUsd: 0.02, tokensUsed: 42 } });
    expect(draft.body).toContain('- [x] npm test');
    expect(draft.body).not.toContain('npm run lint');
    expect(created).toEqual(['claude']);
    expect(specs[0]).toMatchObject({ model: 'opus', allowedTools: [], cwd: '/wt', env: { ACCOUNT: 'work', CEZ_MOCK_ARGS_FILE: '' } });
    expect(specs[0]?.userPrompt).toContain('src/auth.ts (+3 −1)');
  });

  it('redacts what it sends', async () => {
    const { runner, specs } = fakeRunner(async () => ({ text: ANSWER }));
    await describePr(
      { repoRoot: '/repo', run: run({ task: 'token s3cret' }), handoffText: HANDOFF, redact: (t) => t.replaceAll('s3cret', '***') },
      deps(runner),
    );
    expect(specs[0]?.userPrompt).not.toContain('s3cret');
  });

  describe("falls back to today's title and body, unchanged", () => {
    it('under CEZ_DRY_RUN=1, without a model call', async () => {
      const { runner, specs } = fakeRunner(async () => ({ text: ANSWER }));
      const draft = await describePr({ repoRoot: '/repo', run: run(), handoffText: HANDOFF }, deps(runner, { env: { CEZ_DRY_RUN: '1' } }));
      expect(draft).toEqual(fallback);
      expect(specs).toHaveLength(0);
    });

    it('when the runner fails', async () => {
      const { runner } = fakeRunner(async () => {
        throw new Error('spawn claude ENOENT');
      });
      expect(await describePr({ repoRoot: '/repo', run: run(), handoffText: HANDOFF }, deps(runner))).toEqual(fallback);
    });

    it('when the answer is junk, still reporting what it cost', async () => {
      const { runner } = fakeRunner(async (_spec, onEvent) => {
        onEvent?.({ type: 'cost', usd: 0.01 } as AgentEvent);
        return { text: 'Sure! Here is a PR.' };
      });
      const draft = await describePr({ repoRoot: '/repo', run: run(), handoffText: HANDOFF }, deps(runner));
      expect(draft).toEqual({ ...fallback, usage: { costUsd: 0.01, tokensUsed: 42 } });
    });

    it('when the turn times out, interrupting it', async () => {
      const { runner, interrupt } = fakeRunner(() => new Promise(() => {}));
      const draft = await describePr({ repoRoot: '/repo', run: run(), handoffText: HANDOFF }, deps(runner, { timeoutMs: 10 }));
      expect(draft).toEqual(fallback);
      expect(interrupt).toHaveBeenCalled();
    });

    it('when the diff cannot be read or is empty', async () => {
      const { runner, specs } = fakeRunner(async () => ({ text: ANSWER }));
      const input = { repoRoot: '/repo', run: run(), handoffText: HANDOFF };
      expect(await describePr(input, deps(runner, { diff: async () => null }))).toEqual(fallback);
      expect(await describePr(input, deps(runner, { diff: async () => ({ files: [], patch: '', truncated: false }) }))).toEqual(fallback);
      expect(specs).toHaveLength(0);
    });
  });

  it("books the turn's spend on the run's last agent step", () => {
    const record = run();
    const updateStep = vi.fn();
    const appendEvent = vi.fn();
    const store = { getRun: () => record, updateStep, appendEvent };
    recordPrDescribeUsage(store, 'r1', { title: 't', body: 'b', generated: true, usage: { costUsd: 0.02, tokensUsed: 42 } });
    expect(updateStep).toHaveBeenCalledWith('r1', 'task', { tokensUsed: 142, costUsd: 0.52 });
    expect(appendEvent).toHaveBeenCalledWith('r1', { type: 'note', message: 'PR description generated — $0.0200' });

    updateStep.mockClear();
    recordPrDescribeUsage(store, 'r1', fallback);
    expect(updateStep).not.toHaveBeenCalled();
  });
});
