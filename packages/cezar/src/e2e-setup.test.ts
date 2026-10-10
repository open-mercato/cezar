import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { E2E_CREDENTIAL_NAMES } from '@open-mercato/cezar-contract';
import { E2E_WORKFLOW_TEMPLATE, e2eCredentialsAmong, e2eSetupWorkflow } from './e2e-setup.ts';
import { stepsIssue, workflowDefSchema, workflowFileSchema } from './workflows/types.ts';

describe('e2e setup workflow (spec 2026-10-10-e2e-one-click-setup)', () => {
  it('is a valid ad-hoc chain whose checks loop back to the setup step on any exit code', () => {
    for (const credentials of [[], ['OPENAI_API_KEY']] as const) {
      const workflow = workflowDefSchema.parse(e2eSetupWorkflow(credentials));
      expect(stepsIssue(workflow.steps)).toBeNull();
      const checks = workflow.steps.filter((s) => s.command);
      expect(checks.map((s) => s.onFail)).toEqual([
        { retry: 'setup', max: 2 },
        { retry: 'setup', max: 2 },
      ]);
      // The repo-pinned binary, never the registry's latest; vendor telemetry off.
      for (const check of checks) expect(check.command).toMatch(/E2E_TELEMETRY_DISABLED=1 npx --no-install e2e /);
    }
  });

  it('leaves behind a workflow file the loader accepts, gated on e2e verdicts only', () => {
    const doc = workflowFileSchema.parse(parseYaml(E2E_WORKFLOW_TEMPLATE));
    expect(doc.name).toBe('implement-and-e2e');
    expect(stepsIssue(doc.steps ?? [])).toBeNull();
    expect(doc.steps?.find((s) => s.id === 'browser')?.onFail).toEqual({ retry: 'implement', max: 2, retryOn: [1] });
  });

  it('embeds the template verbatim in the agent prompt', () => {
    expect(e2eSetupWorkflow([]).steps[0]!.prompt).toContain(E2E_WORKFLOW_TEMPLATE);
  });

  it('names the provider of the first stored key, in preference order', () => {
    expect(e2eCredentialsAmong(['OPENROUTER_API_KEY', 'OTHER', 'OPENAI_API_KEY'])).toEqual(['OPENAI_API_KEY', 'OPENROUTER_API_KEY']);
    for (const name of E2E_CREDENTIAL_NAMES) {
      expect(e2eSetupWorkflow([name]).steps[0]!.prompt).toContain(`\`${name}\``);
    }
  });
});
