import type { WorkflowCapabilities } from '@open-mercato/cezar-contract';
import type { AgentBackend } from '../core/agent-runner.ts';
import type { GraphNode } from './graph.ts';
import { DEFAULT_ALLOWED_TOOLS, stepKind, type WorkflowDef, type WorkflowStepDef } from './types.ts';

/**
 * What a workflow can do outside the machine, read statically from its definition so a manager
 * (or a person) can pick one safely. Conservative by construction: a false "read-only" is the
 * dangerous error, so anything this cannot prove harmless counts as able to do everything — an
 * agent with an unrestricted shell can `git push`, `gh pr create` and `gh pr comment`.
 */

const ALL: WorkflowCapabilities = { push: true, openPr: true, postToGithub: true };
const NONE: WorkflowCapabilities = { push: false, openPr: false, postToGithub: false };

/** Tools that read, or write only inside the worktree; none of them reaches a remote. */
const LOCAL_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'TodoWrite', 'WebSearch', 'WebFetch']);

/**
 * Bash prefixes that only read, whatever flags follow (a prefix admits any of them). Left out on
 * purpose: `git fetch` (`--upload-pack` runs a command), `gh api` (`-X POST` writes), `git grep`
 * (`-O` runs a pager command) and `git log/diff/show/blame` (`--output` writes any file,
 * `.git/config` included). The PR itself is read through `gh pr diff`.
 */
export const READ_ONLY_BASH_PREFIXES = [
  'gh pr view',
  'gh pr diff',
  'gh pr checks',
  'gh pr list',
  'gh issue view',
  'gh issue list',
  'gh repo view',
  'git status',
  'git ls-files',
  'git rev-parse',
  'git merge-base',
] as const;

function isReadOnlyCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, ' ');
  return READ_ONLY_BASH_PREFIXES.some((p) => c === p || c.startsWith(`${p} `));
}

/** An agent step: what its tool grant lets it reach. */
function agentCapabilities(step: Pick<WorkflowStepDef, 'allowedTools' | 'bashAllowlist'>): WorkflowCapabilities {
  for (const tool of step.allowedTools ?? DEFAULT_ALLOWED_TOOLS) {
    if (tool === 'Bash') {
      if (!step.bashAllowlist?.length || !step.bashAllowlist.every(isReadOnlyCommand)) return ALL;
    } else if (!LOCAL_TOOLS.has(tool)) {
      // An MCP server or an unknown tool may well publish.
      return ALL;
    }
  }
  return NONE;
}

/** A check step: a shell command run with the user's own credentials. */
function checkCapabilities(command: string): WorkflowCapabilities {
  if (/[`$<>]|\$\(/.test(command)) return ALL;
  const parts = command.split(/&&|\|\||[;|&\n]/).map((p) => p.trim()).filter(Boolean);
  return parts.length && parts.every(isReadOnlyCommand) ? NONE : ALL;
}

function stepCapabilities(step: WorkflowStepDef): WorkflowCapabilities {
  return stepKind(step) === 'check' ? checkCapabilities(step.command ?? '') : agentCapabilities(step);
}

function nodeCapabilities(node: GraphNode, lookup: (name: string) => WorkflowDef | undefined, seen: Set<string>): WorkflowCapabilities {
  switch (node.type) {
    case 'agent':
      return agentCapabilities(node);
    case 'check':
      return checkCapabilities(node.command);
    case 'github.draft-pr':
      return { push: true, openPr: true, postToGithub: false };
    case 'git.push':
      return { push: true, openPr: false, postToGithub: false };
    case 'github.pr-comment':
    case 'github.issue-comment':
    case 'github.pr-update':
      return { push: false, openPr: false, postToGithub: true };
    // A dispatched child is an implementer with the default tools.
    case 'dispatch':
      return ALL;
    case 'workflow': {
      // A cycle back into a workflow already counted adds nothing new.
      if (seen.has(node.workflow)) return NONE;
      const child = lookup(node.workflow);
      return child ? capabilitiesOf(child, lookup, seen) : ALL;
    }
    default:
      return NONE;
  }
}

function capabilitiesOf(def: WorkflowDef, lookup: (name: string) => WorkflowDef | undefined, seen: Set<string>): WorkflowCapabilities {
  const inner = new Set(seen).add(def.name);
  const parts = def.graph ? def.graph.nodes.map((n) => nodeCapabilities(n, lookup, inner)) : def.steps.map(stepCapabilities);
  return parts.reduce<WorkflowCapabilities>(
    (acc, c) => ({ push: acc.push || c.push, openPr: acc.openPr || c.openPr, postToGithub: acc.postToGithub || c.postToGithub }),
    NONE,
  );
}

/** `catalog` resolves a `workflow` node's sub-workflow; one it cannot find counts as ALL. */
export function workflowCapabilities(def: WorkflowDef, catalog: readonly WorkflowDef[] = []): WorkflowCapabilities {
  return capabilitiesOf(def, (name) => catalog.find((w) => w.name === name), new Set());
}

export function isReadOnlyWorkflow(def: WorkflowDef, catalog: readonly WorkflowDef[] = []): boolean {
  const c = workflowCapabilities(def, catalog);
  return !c.push && !c.openPr && !c.postToGithub;
}

/**
 * Backends that hold an agent to its `allowedTools`/`bashAllowlist` (AGENT_PROTOCOL.md). A
 * Record, so a new runner does not compile until someone decides. Pi drops Bash entirely under
 * an allowlist, which is stricter still; Kimi runs its other tools unasked, so it is not here.
 */
const TOOL_LIMITS_ENFORCED: Record<AgentBackend, boolean> = {
  claude: true,
  'claude-cli': true,
  pi: true,
  codex: false,
  opencode: false,
  cursor: false,
  junie: false,
  copilot: false,
  gemini: false,
  kimi: false,
  omp: false,
  antigravity: false,
};

/**
 * A read-only workflow's agent refuses a backend that would ignore its tool limits — the only
 * thing between it and a push. `undefined` when the step may run.
 */
export function readOnlyWorkflowRefusal(def: WorkflowDef | undefined, backend: AgentBackend): string | undefined {
  if (!def || TOOL_LIMITS_ENFORCED[backend] || !isReadOnlyWorkflow(def)) return undefined;
  return `${backend} does not enforce a step's tool limits, so the read-only workflow "${def.name}" will not run on it — pick Claude Code or Pi for this task.`;
}
