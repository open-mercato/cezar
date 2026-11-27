import { describe, expect, it } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { buildClaudeArgs, claudeArtifactsWriteRule, claudeReadOnlyPathRules } from '../core/claude-cli-runner.ts';
import { codexBashArgv, compileCodexRestrictedPolicy } from '../core/codex-restricted-policy.ts';
import { grantsFileWrites, isReadOnlyWorkflow } from './capabilities.ts';
import { workflowLaunchSpec } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { REVIEW_PR } from './templates.ts';

const ARTIFACTS = '/tmp/cez-artifacts/run-1';
const agents = REVIEW_PR.graph!.nodes.flatMap((n) => (n.type === 'agent' ? [n] : []));

/** Everything a reviewer must never be able to run: posting, pushing, editing and raw API calls. */
const PUBLISHING = [
  'gh pr review 1 --approve',
  'gh pr review 1 --comment -b looks good',
  'gh pr comment 1 --body hi',
  'gh pr merge 1 --squash',
  'gh pr edit 1 --add-label x',
  'gh pr close 1',
  'gh pr create --fill',
  'gh pr ready 1',
  'gh issue comment 1 --body hi',
  'gh api -X POST repos/o/r/issues/1/comments -f body=hi',
  'gh api repos/o/r/pulls/1/reviews --method POST',
  'git push origin HEAD',
  'git push --force origin main',
  'git fetch --upload-pack=touch origin',
  'git commit -am x',
];

function spec(node: (typeof agents)[number], extra: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return { systemPrompt: '', userPrompt: '', cwd: '/repo', allowedTools: node.allowedTools, bashAllowlist: node.bashAllowlist, artifactsWriteDir: ARTIFACTS, ...extra } as AgentRunSpec;
}

/** Claude's `--allowedTools` rules for a spec. */
function claudeRules(s: AgentRunSpec): string[] {
  const args = buildClaudeArgs(s, {});
  const i = args.indexOf('--allowedTools');
  return i < 0 ? [] : args[i + 1]!.split(',');
}

/** Whether Claude's `--allowedTools` rule list admits `command` (`Bash(p:*)` admits any command starting with `p`). */
function ruleListAdmits(rules: string[], command: string): boolean {
  return rules.some((rule) => {
    if (rule === 'Bash') return true;
    const m = /^Bash\((.*):\*\)$/.exec(rule);
    return !!m && (command === m[1] || command.startsWith(`${m[1]} `));
  });
}

describe('review-pr tool policy', () => {
  it('is a read-only workflow with a deterministic checkout first', () => {
    expect(isReadOnlyWorkflow(REVIEW_PR)).toBe(true);
    expect(REVIEW_PR.graph!.edges).toContainEqual({ from: 'start', to: 'checkout' });
    expect(REVIEW_PR.graph!.nodes.find((n) => n.id === 'checkout')?.type).toBe('github.pr-checkout');
    expect(agents.map((a) => a.id)).toEqual(['correctness', 'security', 'tests', 'judge']);
  });

  describe.each(agents.map((a) => [a.id, a] as const))('Claude: %s', (_id, node) => {
    const rules = claudeRules(spec(node));

    it('reads the PR files and may write only its own artifacts directory', () => {
      expect(rules).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', `Edit(/${ARTIFACTS}/**)`]));
      expect(rules).not.toContain('Write');
      expect(rules).not.toContain('Edit');
      expect(rules).not.toContain('Bash');
      expect(buildClaudeArgs(spec(node), {})).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    });

    it.each(PUBLISHING)('refuses %s', (command) => {
      expect(ruleListAdmits(rules, command)).toBe(false);
    });

    it('admits the read-only fallback', () => {
      expect(ruleListAdmits(rules, 'gh pr view 5700 --json title,files')).toBe(true);
      expect(ruleListAdmits(rules, 'gh pr diff 5700')).toBe(true);
    });
  });

  describe.each(agents.map((a) => [a.id, a] as const))('Codex: %s', (_id, node) => {
    // The restricted judge step used to be refused here before the model ever started.
    const policy = compileCodexRestrictedPolicy(spec(node));

    it('compiles to an isolated read-only policy instead of refusing the step', () => {
      expect(policy?.mutation).toBe('read-only');
      expect([...policy!.tools].sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read']);
    });

    it.each(PUBLISHING)('refuses %s', (command) => {
      expect(codexBashArgv(command, policy!)).toBeUndefined();
    });

    it('admits the read-only fallback', () => {
      expect(codexBashArgv('gh pr view 5700 --json title', policy!)).toEqual(['gh', 'pr', 'view', '5700', '--json', 'title']);
      expect(codexBashArgv('gh pr diff 5700', policy!)).toEqual(['gh', 'pr', 'diff', '5700']);
    });
  });
});

describe('claudeArtifactsWriteRule', () => {
  const base = { allowedTools: ['Read', 'Grep'], artifactsWriteDir: ARTIFACTS };
  it('scopes a restricted step to its artifacts directory', () => {
    expect(claudeArtifactsWriteRule(base)).toBe(`Edit(/${ARTIFACTS}/**)`);
  });
  it('adds nothing when the step must not write, may write anyway, or has no grant', () => {
    expect(claudeArtifactsWriteRule({ ...base, enforceReadOnly: true })).toBeUndefined();
    expect(claudeArtifactsWriteRule({ ...base, allowedTools: ['Read', 'Write'] })).toBeUndefined();
    expect(claudeArtifactsWriteRule({ artifactsWriteDir: ARTIFACTS })).toBeUndefined();
    expect(claudeArtifactsWriteRule({ ...base, artifactsWriteDir: 'relative/dir' })).toBeUndefined();
    expect(claudeArtifactsWriteRule({ ...base, artifactsWriteDir: '/tmp/a,Bash' })).toBeUndefined();
  });
  it('keeps a manager read-only task fenced: no write rule, writes disallowed', () => {
    const args = buildClaudeArgs({ systemPrompt: '', userPrompt: '', cwd: '/repo', ...base, enforceReadOnly: true } as AgentRunSpec, {});
    expect(args.join(' ')).not.toContain('Edit(/');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Write');
  });
  it('makes the artifacts directory reachable', () => {
    const args = buildClaudeArgs({ systemPrompt: '', userPrompt: '', cwd: '/repo', ...base } as AgentRunSpec, {});
    expect(args[args.indexOf('--add-dir') + 1]).toBe(ARTIFACTS);
  });
  it('does not add the artifacts directory twice when it is already an additional directory', () => {
    const args = buildClaudeArgs({ systemPrompt: '', userPrompt: '', cwd: '/repo', ...base, additionalDirectories: ['/runs', ARTIFACTS] } as AgentRunSpec, {});
    expect(args.filter((a, i) => args[i - 1] === '--add-dir')).toEqual(['/runs', ARTIFACTS]);
  });
  it('forces dontAsk when strictPermissions is set, even under CEZ_APPROVAL_GATE=1 or bypassPermissions', () => {
    const mode = (args: string[]) => args[args.indexOf('--permission-mode') + 1];
    const s = { systemPrompt: '', userPrompt: '', cwd: '/repo', ...base } as AgentRunSpec;
    expect(mode(buildClaudeArgs(s, { CEZ_APPROVAL_GATE: '1' }))).toBe('acceptEdits');
    expect(mode(buildClaudeArgs({ ...s, strictPermissions: true }, { CEZ_APPROVAL_GATE: '1' }))).toBe('dontAsk');
    expect(mode(buildClaudeArgs({ ...s, strictPermissions: true, bypassPermissions: true }, { CEZ_APPROVAL_GATE: '1' }))).toBe('dontAsk');
  });
});

describe('claudeReadOnlyPathRules', () => {
  it('denies every file-writing tool on each path, beside the enforceReadOnly denies', () => {
    expect(claudeReadOnlyPathRules(['/pr/**', '/art/pr-*.diff'])).toEqual(['Edit(//pr/**)', 'Edit(//art/pr-*.diff)']);
    const args = buildClaudeArgs({ systemPrompt: '', userPrompt: '', cwd: '/repo', allowedTools: ['Read'], enforceReadOnly: true, readOnlyPaths: ['/pr/**'] } as AgentRunSpec, {});
    expect(args.filter((a) => a === '--disallowedTools')).toHaveLength(1);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash,Edit,Write,MultiEdit,NotebookEdit,Edit(//pr/**)');
  });
  it('drops a path a rule cannot express rather than widening it', () => {
    expect(claudeReadOnlyPathRules(['relative/**', '/a,Bash', '/b(x)'])).toEqual([]);
  });
});

describe('grantsFileWrites', () => {
  it('is false for review-pr and true for a step with Edit, Write, MultiEdit or an unrestricted shell', () => {
    expect(grantsFileWrites(REVIEW_PR)).toBe(false);
    for (const tools of [['Read', 'Edit'], ['Read', 'Write'], ['Read', 'MultiEdit'], ['Read', 'Bash']]) {
      const def = { ...REVIEW_PR, graph: { ...REVIEW_PR.graph!, nodes: REVIEW_PR.graph!.nodes.map((n) => (n.type === 'agent' && n.id === 'judge' ? { ...n, allowedTools: tools, bashAllowlist: undefined } : n)) } };
      expect(grantsFileWrites(def), tools.join()).toBe(true);
    }
  });
});

describe('workflowLaunchSpec', () => {
  const dirs = { artifacts: ARTIFACTS, prCheckout: '/data/pr-checkouts/run-1' };
  const made = () => true;
  const PROTECTED = [`${dirs.prCheckout}/**`, `${ARTIFACTS}/pr-*.diff`, `${ARTIFACTS}/pr-*.json`];
  const withJudgeTools = (allowedTools: string[] | undefined) => ({
    ...REVIEW_PR,
    name: 'fix-pr',
    graph: {
      ...REVIEW_PR.graph!,
      nodes: REVIEW_PR.graph!.nodes.map((n) => (n.type === 'agent' && n.id === 'judge' ? { ...n, allowedTools, bashAllowlist: undefined } : n)),
    },
  });
  it('gives review-pr steps their artifacts, the PR folder to read but never write, and no bypass', () => {
    expect(workflowLaunchSpec(REVIEW_PR, {}, dirs, made)).toEqual({ readOnlyWorkflow: true, artifactsWriteDir: ARTIFACTS, prDirs: [dirs.prCheckout], readOnlyPaths: PROTECTED });
  });
  it('adds no PR folder that was never made (no PR URL, or the checkout failed early)', () => {
    expect(workflowLaunchSpec(REVIEW_PR, {}, dirs, () => false).prDirs).toEqual([]);
    expect(workflowLaunchSpec(REVIEW_PR, {}, { ...dirs, prCheckout: '/definitely/not/there' }).prDirs).toEqual([]);
  });
  it('lets an Ask task write nothing new', () => {
    expect(workflowLaunchSpec(REVIEW_PR, { readOnly: true }, dirs, made).artifactsWriteDir).toBeUndefined();
  });
  it('leaves a writable workflow without a PR checkout exactly as before', () => {
    expect(workflowLaunchSpec(QUICK_TASK_WORKFLOW, {}, dirs, made)).toEqual({ readOnlyWorkflow: false, prDirs: [], readOnlyPaths: [] });
    expect(workflowLaunchSpec(undefined, {}, dirs, made)).toEqual({ readOnlyWorkflow: false, prDirs: [], readOnlyPaths: [] });
  });
  it('gives every step of a writable workflow that checks a PR out the PR folder to read, never to write, and no artifacts grant', () => {
    expect(workflowLaunchSpec(withJudgeTools(undefined), {}, dirs, made)).toEqual({ readOnlyWorkflow: false, prDirs: [dirs.prCheckout], readOnlyPaths: PROTECTED });
  });
  it('treats a workflow that can only Read/Edit/Write as writable: it keeps bypass and acceptEdits, and gains no artifacts grant', () => {
    for (const tools of [['Read', 'Edit'], ['Read', 'Write'], ['Read', 'MultiEdit']]) {
      const def = withJudgeTools(tools);
      expect(isReadOnlyWorkflow(def), tools.join()).toBe(true); // it still cannot publish
      expect(workflowLaunchSpec(def, {}, dirs, made), tools.join()).toEqual({ readOnlyWorkflow: false, prDirs: [dirs.prCheckout], readOnlyPaths: PROTECTED });
    }
  });
});
