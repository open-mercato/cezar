import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cezBinPath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';
import { ASSESS_IMPACT_WORKFLOW } from './templates.ts';
import { stepsIssue, workflowStepSchema } from './types.ts';

/** The built-in `assess-impact` workflow (spec 2026-10-22-html-artifacts-and-impact § Assess Impact). */
describe('assess-impact', () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-assess-impact-'));
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('is one valid agent step on the change-impact skill, ending with the done contract', () => {
    expect(ASSESS_IMPACT_WORKFLOW.steps).toHaveLength(1);
    const [step] = ASSESS_IMPACT_WORKFLOW.steps;
    expect(workflowStepSchema.safeParse(step).success).toBe(true);
    expect(stepsIssue(ASSESS_IMPACT_WORKFLOW.steps)).toBeNull();
    expect(step).toMatchObject({ skill: 'change-impact' });
    expect(step!.prompt!.startsWith('{{task}}')).toBe(true);
    expect(step!.prompt).toContain('$CEZ_ARTIFACTS_DIR');
    expect(step!.prompt).toContain('node "$CEZ_BIN" impact');
    expect(step!.prompt).toMatch(/make no commits/);
    expect(step!.prompt!.endsWith('Done means `cez impact render` printed `ok`.')).toBe(true);
  });

  it('is in the catalog as a built-in, comes back after delete, and a repo file of the name wins', async () => {
    expect((await loadWorkflows(repoRoot)).workflows.find((w) => w.name === 'assess-impact')?.source).toBe('built-in');
    const dir = join(repoRoot, '.ai/cezar/workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'assess-impact.yaml'), 'name: assess-impact\nsteps:\n  - { id: mine, prompt: "{{task}}" }\n');
    const mine = (await loadWorkflows(repoRoot)).workflows.filter((w) => w.name === 'assess-impact');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: 'file' });
    rmSync(join(dir, 'assess-impact.yaml'));
    expect((await loadWorkflows(repoRoot)).workflows.find((w) => w.name === 'assess-impact')?.source).toBe('built-in');
  });
});

/** `cez impact` is local: the agent reaches it through `$CEZ_BIN` with dispatch OFF and no cockpit. */
describe('CEZ_BIN for every run', () => {
  const saved = { dispatch: process.env.CEZ_DISPATCH, api: process.env.CEZ_API_URL, bin: process.env.CEZ_BIN };
  let repoRoot: string;
  let store: RunStore;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-assess-bin-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_DISPATCH', saved.dispatch], ['CEZ_API_URL', saved.api], ['CEZ_BIN', saved.bin]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is set with CEZ_DISPATCH=0 and no CEZ_API_URL, and names an existing entrypoint', () => {
    process.env.CEZ_DISPATCH = '0';
    delete process.env.CEZ_API_URL;
    delete process.env.CEZ_BIN;
    const manager = new RunManager(store, repoRoot);
    const run = store.createRun({ title: 't', workflow: 'assess-impact', task: 't', steps: [] });
    const env = (manager as unknown as { agentEnv(id: string): Record<string, string> }).agentEnv(run.id);
    expect(env.CEZ_BIN).toBe(cezBinPath());
    expect(existsSync(env.CEZ_BIN!)).toBe(true);
    expect(env.CEZ_API_URL).toBeUndefined();
  });

  it("prefers the cockpit's pinned entrypoint", () => {
    process.env.CEZ_BIN = '/opt/cezar/dist/index.js';
    expect(cezBinPath()).toBe('/opt/cezar/dist/index.js');
  });
});
