import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';

/** #2012: bookkeeping calls run on a cheap model per runner, or not at all. */

const specs: AgentRunSpec[] = [];
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    run: async (spec: AgentRunSpec) => {
      specs.push(spec);
      return { text: spec.userPrompt.includes('[cez-namer]') ? '{"title":"fixing login"}' : '{"subject":"Add a"}' };
    },
  }),
}));

const { generateRunName } = await import('./auto-name.ts');
const { generateCommitMessage } = await import('../workflows/commit-message.ts');
const { pickCheapModel, resolveNamerModel, setNamerModelCatalog } = await import('./namer-model.ts');

const config = { namerModel: 'haiku' };
let root: string;
const savedEnv = { dry: process.env.CEZ_DRY_RUN, auto: process.env.CEZ_AUTONAME };

function projectWith(runner: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: runner, ...extra }));
}

beforeEach(() => {
  specs.length = 0;
  delete process.env.CEZ_DRY_RUN;
  delete process.env.CEZ_AUTONAME;
  root = mkdtempSync(join(tmpdir(), 'cez-namer-model-'));
});

afterEach(() => {
  setNamerModelCatalog(undefined);
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [['CEZ_DRY_RUN', savedEnv.dry], ['CEZ_AUTONAME', savedEnv.auto]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('pickCheapModel', () => {
  it('takes the cheapest tier at its lowest effort, matching whole id segments only', () => {
    expect(pickCheapModel([
      { id: 'gpt-6.1-sol', label: '', description: '' },
      { id: 'gpt-6.1-mini', label: '', description: '', reasoningEfforts: [{ id: 'high', description: '' }, { id: 'low', description: '' }] },
    ])).toEqual({ model: 'gpt-6.1-mini', reasoningEffort: 'low' });
    expect(pickCheapModel([{ id: 'anthropic/claude-sonnet-5', label: '', description: '' }, { id: 'anthropic/claude-haiku-5', label: '', description: '' }]))
      .toEqual({ model: 'anthropic/claude-haiku-5' });
    // `gemini` is not a `mini`.
    expect(pickCheapModel([{ id: 'gemini-2.5-pro', label: '', description: '' }])).toBeUndefined();
    expect(pickCheapModel([])).toBeUndefined();
  });
});

describe('resolveNamerModel', () => {
  it('prefers an explicit per-runner model, then Claude namerModel, then discovery, then a static default', async () => {
    expect(await resolveNamerModel('copilot', { ...config, namerModels: { copilot: 'gpt-5-mini' } })).toEqual({ model: 'gpt-5-mini' });
    expect(await resolveNamerModel('claude', config)).toEqual({ model: 'haiku' });
    expect(await resolveNamerModel('codex', config, {})).toEqual({ model: 'gpt-5.1-codex-mini', reasoningEffort: 'medium' });
    setNamerModelCatalog({ get: async () => ({ models: [{ id: 'gpt-6.1-nano', label: '', description: '', reasoningEfforts: [{ id: 'low', description: '' }] }] }) });
    expect(await resolveNamerModel('codex', config, {})).toEqual({ model: 'gpt-6.1-nano', reasoningEffort: 'low' });
    // Effort is dropped on a runner whose seam refuses it.
    expect(await resolveNamerModel('cursor', config, {})).toEqual({ model: 'gpt-6.1-nano' });
  });

  it('answers null for a runner with no cheap model, so the caller skips the call', async () => {
    expect(await resolveNamerModel('copilot', config, {})).toBeNull();
    setNamerModelCatalog({ get: async () => { throw new Error('offline'); } });
    expect(await resolveNamerModel('copilot', config, {})).toBeNull();
  });
});

describe('generateRunName / generateCommitMessage model choice (#2012)', () => {
  const staged = { files: [{ status: 'A', path: 'a.md' }], patch: '+a' };

  it('never calls the default (premium) model on a runner without a cheap one', async () => {
    projectWith('copilot');
    expect(await generateRunName(root, { task: 'fix login' })).toBeNull();
    expect(await generateCommitMessage(root, staged)).toEqual({ reason: 'no cheap model known for copilot' });
    expect(specs).toEqual([]);
  });

  it('passes the cheap model and effort on Codex, and the configured one on any runner', async () => {
    projectWith('codex');
    expect(await generateRunName(root, { task: 'fix login' })).toEqual({ titleSummary: 'fixing login' });
    expect(await generateCommitMessage(root, staged)).toEqual({ subject: 'Add a' });
    expect(specs.map((s) => [s.model, s.reasoningEffort])).toEqual([
      ['gpt-5.1-codex-mini', 'medium'],
      ['gpt-5.1-codex-mini', 'medium'],
    ]);
    specs.length = 0;
    projectWith('copilot', { namerModels: { copilot: 'gpt-5-mini' } });
    await generateRunName(root, { task: 'fix login' }, { runner: 'copilot', env: {} });
    expect(specs.map((s) => s.model)).toEqual(['gpt-5-mini']);
  });
});
