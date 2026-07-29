import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflows } from '../workflows/load.js';
import { stepsIssue, stepKind } from '../workflows/types.js';
import {
  HARNESS_FIX_ISSUE,
  HARNESS_IMPLEMENT_FEATURE,
  harnessWorkflowDefs,
  isHarnessWorkflow,
} from './workflows.js';

/**
 * The two built-in harness workflows (spec 2026-07-23-harness-orchestration,
 * Architecture §1). Their `steps` exist for the rail and the record — the
 * phase DRIVER executes them, not the linear walker — but they must still be
 * structurally sound so every existing steps consumer (createRun, the GUI
 * rail, workflowDef revival) works unchanged.
 */
describe('harness built-in workflows', () => {
  it('exposes two harness workflows with sound step lists', () => {
    const defs = harnessWorkflowDefs();
    expect(defs.map((d) => d.name).sort()).toEqual([HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE].sort());
    for (const def of defs) {
      expect(def.source).toBe('built-in');
      expect(stepsIssue(def.steps)).toBeNull();
      expect(def.steps.some((s) => stepKind(s) === 'agent')).toBe(true);
      expect(def.steps.some((s) => stepKind(s) === 'check')).toBe(true);
    }
  });

  it('isHarnessWorkflow matches exactly the two harness names', () => {
    expect(isHarnessWorkflow(HARNESS_FIX_ISSUE)).toBe(true);
    expect(isHarnessWorkflow(HARNESS_IMPLEMENT_FEATURE)).toBe(true);
    expect(isHarnessWorkflow('quick-task')).toBe(false);
    expect(isHarnessWorkflow('(planned)')).toBe(false);
  });

  describe('catalog integration', () => {
    let repoRoot: string;

    beforeEach(() => {
      repoRoot = mkdtempSync(join(tmpdir(), 'cez-harness-wf-'));
    });

    afterEach(() => {
      rmSync(repoRoot, { recursive: true, force: true });
    });

    it('loadWorkflows lists the harness workflows beside quick-task', async () => {
      const { workflows } = await loadWorkflows(repoRoot);
      const names = workflows.map((w) => w.name);
      expect(names).toContain('quick-task');
      expect(names).toContain(HARNESS_FIX_ISSUE);
      expect(names).toContain(HARNESS_IMPLEMENT_FEATURE);
    });
  });
});
