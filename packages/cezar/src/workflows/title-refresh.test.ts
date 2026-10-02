import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import type { Skill } from '../skills.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const counters = vi.hoisted(() => ({ createRunner: 0, discoverSkills: 0, prompts: [] as string[] }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => {
    counters.createRunner++;
    return {
      backend: 'claude' as const,
      run: async (spec: AgentRunSpec) => {
        counters.prompts.push(spec.userPrompt);
        return { text: '{"title":"refreshing the title"}', toolCalls: [], tokensUsed: 0 };
      },
      startSession: () => {
        throw new Error('no agent session in this suite');
      },
      interrupt: async () => {},
    };
  },
}));

vi.mock('../skills.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills.ts')>();
  return {
    ...actual,
    discoverSkills: async (repoRoot: string) => {
      counters.discoverSkills++;
      return actual.discoverSkills(repoRoot);
    },
  };
});

const SKILL_DEF: WorkflowDef = {
  name: 'skill-task',
  source: 'file',
  steps: [{ id: 'work', name: 'Work', skill: 'om-auto-review-pr', prompt: '{{task}}' }],
};

type Seam = {
  recordTurnEnd(id: string, text: string): Promise<void>;
  active: Map<string, { skills?: Skill[] }>;
};

describe('live title refresh: namer calls per turn', () => {
  const TURNS = 5;
  const ENV_KEYS = ['CEZ_DRY_RUN', 'CEZ_AUTONAME', 'CEZ_TITLE_UPDATES'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    delete process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_AUTONAME;
    delete process.env.CEZ_TITLE_UPDATES;
    counters.createRunner = 0;
    counters.discoverSkills = 0;
    counters.prompts.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-title-refresh-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function namerOwnedRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: SKILL_DEF.name,
      task: 'review 437',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' as const }],
    });
    store.updateRun(record.id, { status: 'running', workflowDef: SKILL_DEF, titleOrigin: 'auto' });
    return record.id;
  }

  async function turns(runId: string): Promise<void> {
    for (let i = 0; i < TURNS; i++) await (manager as unknown as Seam).recordTurnEnd(runId, `progress on turn ${i}`);
  }

  it('the zero-config default spawns no namer at a turn end', async () => {
    const runId = namerOwnedRun();
    await turns(runId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counters.createRunner).toBe(0);
    expect(store.getRun(runId)?.titleSummary).toBeUndefined();
  });

  it('CEZ_TITLE_UPDATES=1 opts back in: one namer call per turn', async () => {
    process.env.CEZ_TITLE_UPDATES = '1';
    const runId = namerOwnedRun();
    await turns(runId);
    await expect.poll(() => counters.createRunner, { timeout: 10_000 }).toBe(TURNS);
  });

  it('a live refresh reads the skill description from the run snapshot, never a fresh scan', async () => {
    process.env.CEZ_TITLE_UPDATES = '1';
    const runId = namerOwnedRun();
    (manager as unknown as Seam).active.set(runId, {
      skills: [{ name: 'om-auto-review-pr', description: 'SNAPSHOT DESCRIPTION', body: '', path: '', source: 'ai' }],
    });
    await turns(runId);
    await expect.poll(() => counters.prompts.length, { timeout: 10_000 }).toBe(TURNS);
    expect(counters.discoverSkills).toBe(0);
    expect(counters.prompts.every((p) => p.includes('Skill description: SNAPSHOT DESCRIPTION'))).toBe(true);
    (manager as unknown as Seam).active.delete(runId);
  });

  it('an EMPTY skills snapshot (failed discovery) rescans instead of dropping the description', async () => {
    process.env.CEZ_TITLE_UPDATES = '1';
    mkdirSync(join(repoRoot, '.ai/skills'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/skills/om-auto-review-pr.md'),
      '---\nname: om-auto-review-pr\ndescription: FRESH SCAN DESCRIPTION\n---\nbody\n',
    );
    const runId = namerOwnedRun();
    // What runContinuation leaves behind when its one discovery call throws: [].
    (manager as unknown as Seam).active.set(runId, { skills: [] });
    await turns(runId);
    await expect.poll(() => counters.prompts.length, { timeout: 10_000 }).toBe(TURNS);
    expect(counters.discoverSkills).toBeGreaterThan(0);
    expect(counters.prompts.every((p) => p.includes('Skill description: FRESH SCAN DESCRIPTION'))).toBe(true);
    (manager as unknown as Seam).active.delete(runId);
  });
});
