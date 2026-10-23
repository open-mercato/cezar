import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { E2E_CREDENTIAL_NAMES } from '@open-mercato/cezar-contract';
import { E2E_SETUP_PR_TITLE, E2E_WORKFLOW_TEMPLATE, e2eCredentialsAmong, e2eSetupWorkflow } from './e2e-setup.ts';
import { graphIssues } from './workflows/graph.ts';
import { stepsIssue, workflowDefSchema, workflowFileSchema } from './workflows/types.ts';

describe('e2e setup workflow (spec 2026-10-10-e2e-one-click-setup)', () => {
  it('is a valid graph whose checks loop back to the setup step, then opens a draft PR either way', () => {
    for (const credentials of [[], ['OPENAI_API_KEY']] as const) {
      const workflow = workflowDefSchema.parse(e2eSetupWorkflow(credentials));
      const graph = workflow.graph!;
      expect(graphIssues(graph)).toEqual([]);
      expect(workflow.steps.map((s) => s.id)).toEqual(['setup', 'e2e-list', 'e2e-smoke']);
      // Both checks fail into a loop (max 2) that repeats the setup agent.
      for (const check of ['e2e-list', 'e2e-smoke']) {
        const loop = graph.edges.find((e) => e.from === `${check}.fail`)!.to;
        expect(graph.nodes.find((n) => n.id === loop)).toMatchObject({ type: 'loop', max: 2 });
        expect(graph.edges.find((e) => e.from === `${loop}.repeat`)?.to).toBe('setup');
      }
      // Green checks → draft PR → success, whether or not the PR could be opened.
      const end = graph.nodes.find((n) => n.type === 'end')!;
      expect(end).toMatchObject({ status: 'success' });
      expect(graph.edges.find((e) => e.from === 'e2e-smoke.pass')?.to).toBe('pr');
      expect(graph.nodes.find((n) => n.id === 'pr')).toMatchObject({ type: 'github.draft-pr', title: E2E_SETUP_PR_TITLE });
      expect(graph.edges.filter((e) => e.from.startsWith('pr.')).map((e) => [e.from, e.to])).toEqual([['pr.created', end.id], ['pr.failed', end.id]]);
      // The repo-pinned binary, never the registry's latest; vendor telemetry off.
      for (const check of workflow.steps.filter((s) => s.command)) expect(check.command).toMatch(/E2E_TELEMETRY_DISABLED=1 npx --no-install e2e /);
    }
  });

  it('leaves behind a workflow file the loader accepts, gated on e2e verdicts only', () => {
    const doc = workflowFileSchema.parse(parseYaml(E2E_WORKFLOW_TEMPLATE));
    expect(doc.name).toBe('implement-and-e2e');
    expect(stepsIssue(doc.steps ?? [])).toBeNull();
    expect(doc.steps?.find((s) => s.id === 'browser')?.onFail).toEqual({ retry: 'implement', max: 2, retryOn: [1] });
  });

  it('keeps the live {{task}} token out of the agent prompt, and checks the written file has it', () => {
    // The engine substitutes {{task}} in agent prompts, so a verbatim template would make the
    // agent write the SETUP task's text into the user's workflow (found in the live run).
    const workflow = e2eSetupWorkflow([]);
    const prompt = workflow.steps[0]!.prompt!;
    expect(prompt).not.toContain('{{task}}');
    expect(prompt).toContain(E2E_WORKFLOW_TEMPLATE.replaceAll('{{task}}', '__CEZAR_TASK_TOKEN__'));
    expect(workflow.steps.find((s) => s.id === 'e2e-list')!.command).toContain("grep -qF '{{task}}' .ai/cezar/workflows/implement-and-e2e.yaml");
  });

  it('names the provider of the first stored key, in preference order', () => {
    expect(e2eCredentialsAmong(['OPENROUTER_API_KEY', 'OTHER', 'OPENAI_API_KEY'])).toEqual(['OPENAI_API_KEY', 'OPENROUTER_API_KEY']);
    for (const name of E2E_CREDENTIAL_NAMES) {
      expect(e2eSetupWorkflow([name]).steps[0]!.prompt).toContain(`\`${name}\``);
    }
  });
});
