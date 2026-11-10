import { z } from 'zod';
import type { AgentEvent, AgentRunner, RunnerId } from '../core/agent-runner.ts';
import { createRunner } from '../core/runner-factory.ts';
import { worktreeDiffSummary, type TaskDiffSummary } from '../git-worktree.ts';
import { parseStructured } from '../planner.ts';
import type { RunRecord, StepState } from '../runs/store.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { buildPrBody } from './forge/github.ts';

/**
 * Generated PR title and description (#1757): one short turn on the run's own backend turns the
 * task, its handoff notes and its diff into a conventional title plus Summary / Changes /
 * Verification / Changelog. Never throws: every failure, timeout, `CEZ_DRY_RUN=1` or
 * `CEZ_PR_DESCRIBE=0` answers today's run title and `buildPrBody`.
 */

export const PR_DESCRIBE_TIMEOUT_MS = 60_000;
const PR_TITLE_MAX = 100;
const FILES_MAX = 200;

/** `CEZ_PR_DESCRIBE=0` turns generation off; a dry run never spends a model call on it. */
export function prDescriptionActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_PR_DESCRIBE !== '0' && env.CEZ_DRY_RUN !== '1';
}

export const PR_DESCRIBE_SYSTEM_PROMPT =
  'You write pull request titles and descriptions for an AI coding agent cockpit. Do not use any ' +
  'tools; everything you need is in the message. Respond with ONLY a JSON object: {"title": string, ' +
  '"summary": string, "changes": [{"area": string, "items": [string]}], "changelog": string}. Rules: ' +
  '"title" is a Conventional Commits subject — type(scope): imperative description, lowercase type ' +
  'from feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert, at most 72 characters, no ' +
  'trailing period — naming what the CHANGE does, never restating the request. "summary" is 1-3 ' +
  'sentences on what changed and why. "changes" groups the diff by area (a package, module or ' +
  'feature), each item one short line. "changelog" is one line a user would read in release notes. ' +
  'Describe only what the diff shows.';

const describeResponseSchema = z.object({
  title: z.string(),
  summary: z.string().trim().min(1).max(2000),
  changes: z
    .array(
      z.object({
        area: z.string().trim().min(1).max(80),
        items: z.array(z.string().trim().min(1).max(400)).min(1).max(20),
      }),
    )
    .min(1)
    .max(12),
  changelog: z.string().trim().min(1).max(300),
});

const CONVENTIONAL_TITLE_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]{0,39}\))?!?: \S.*$/;

export interface PrDescribeContext {
  task: string;
  /** Today's fallback body — the handoff journal's Goal and Progress log. */
  notes: string;
  diff: TaskDiffSummary;
  /** Names of the run's check steps that passed. */
  checks: string[];
}

export function buildPrDescribePrompt(ctx: PrDescribeContext): string {
  const files = ctx.diff.files
    .slice(0, FILES_MAX)
    .map((f) => `${f.path} (+${f.added} −${f.removed})`)
    .join('\n');
  const more = ctx.diff.files.length > FILES_MAX ? `\n… and ${ctx.diff.files.length - FILES_MAX} more files` : '';
  return [
    'Task the agent was given:',
    ctx.task.trim() || '(given as attachments only)',
    '',
    "Agent's handoff notes:",
    ctx.notes.trim(),
    '',
    'Changed files:',
    (files || '(none)') + more,
    '',
    `Diff${ctx.diff.truncated ? ' (truncated)' : ''}:`,
    ctx.diff.patch,
  ].join('\n');
}

/** Raw model text → `{ title, body }`, or null when the answer is unusable. */
export function composePrDescription(raw: string, checks: string[]): { title: string; body: string } | null {
  const parsed = parseStructured(raw, describeResponseSchema);
  if (!parsed) return null;
  const title = parsed.title.trim().replace(/\.$/, '');
  if (title.length > PR_TITLE_MAX || !CONVENTIONAL_TITLE_RE.test(title)) return null;
  const parts = ['## Summary', '', parsed.summary, '', '## Changes'];
  for (const change of parsed.changes) {
    parts.push('', `### ${change.area}`, '', ...change.items.map((item) => `- ${item.replace(/^[-*]\s+/, '')}`));
  }
  // Only checks the workflow really ran; a run without check steps has no section (#1757).
  if (checks.length > 0) parts.push('', '## Verification', '', ...checks.map((name) => `- [x] ${name}`));
  parts.push('', '## Changelog', '', parsed.changelog, '', '---', '', '🤖 made with cezar');
  return { title, body: parts.join('\n') };
}

export interface PrDraft {
  title: string;
  body: string;
  generated: boolean;
  /** What the generation turn cost — present only when a turn ran. */
  usage?: { costUsd?: number; tokensUsed: number };
}

export interface DescribePrDeps {
  createRunner?: (runner: RunnerId) => AgentRunner;
  profileEnv?: (repoRoot: string, runner: RunnerId, profileId?: string) => Promise<Record<string, string>>;
  diff?: typeof worktreeDiffSummary;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** The agent step whose backend, model and account the generation turn reuses. */
function lastAgentStep(run: RunRecord): StepState | undefined {
  return run.steps.filter((s) => s.kind === 'agent' && s.backend).at(-1);
}

/** The publish dialog's preview: generated when possible, today's title and body otherwise. */
export async function describePr(
  input: { repoRoot: string; run: RunRecord; handoffText: string; redact?: (text: string) => string },
  deps: DescribePrDeps = {},
): Promise<PrDraft> {
  const { run } = input;
  const fallbackBody = buildPrBody(input.handoffText, run.task);
  const fallback: PrDraft = { title: run.title, body: fallbackBody, generated: false };
  const env = deps.env ?? process.env;
  if (!prDescriptionActive(env) || !run.worktreePath) return fallback;
  let usage: PrDraft['usage'];
  try {
    const diff = await (deps.diff ?? worktreeDiffSummary)(run.worktreePath, run.baseBranch ?? 'HEAD', {
      taskBranch: run.branch,
      runStartedAt: run.startedAt,
    });
    if (!diff || diff.files.length === 0) return fallback;
    const step = lastAgentStep(run);
    const runnerId: RunnerId = step?.backend ?? run.runner ?? 'claude';
    // The run's model belongs to the run's runner; a fallback backend keeps its own default.
    const model = runnerId === (run.runner ?? 'claude') ? run.model : undefined;
    const profileEnv = deps.profileEnv
      ?? (async (root, id, profileId) => (await resolveProfileEnvForRoot(root, id, profileId)).env);
    const agentEnv = await profileEnv(input.repoRoot, runnerId, step?.profileId);
    const redact = input.redact ?? ((text: string) => text);
    const checks = run.steps.filter((s) => s.kind === 'check' && s.status === 'done').map((s) => s.name);
    const prompt = buildPrDescribePrompt({
      task: redact(run.task),
      notes: redact(fallbackBody),
      diff: { ...diff, patch: redact(diff.patch) },
      checks,
    });
    const runner = (deps.createRunner ?? createRunner)(runnerId);
    let costUsd: number | undefined;
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'cost') costUsd = (costUsd ?? 0) + event.usd;
    };
    const timeoutMs = deps.timeoutMs ?? PR_DESCRIBE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        void runner.interrupt().catch(() => {});
        resolve(null);
      }, timeoutMs);
    });
    const result = await Promise.race([
      runner
        .run(
          {
            systemPrompt: PR_DESCRIBE_SYSTEM_PROMPT,
            userPrompt: prompt,
            cwd: run.worktreePath,
            allowedTools: [],
            model,
            timeoutMs,
            // The agent's argv capture (dry-run tests) must not see this bookkeeping call.
            env: { ...agentEnv, CEZ_MOCK_ARGS_FILE: '' },
          },
          onEvent,
        )
        .catch(() => null),
      timedOut,
    ]).finally(() => clearTimeout(timer));
    if (result) usage = { ...(costUsd !== undefined ? { costUsd } : {}), tokensUsed: result.tokensUsed };
    else if (costUsd !== undefined) usage = { costUsd, tokensUsed: 0 };
    const composed = result ? composePrDescription(result.text, checks) : null;
    if (!composed) return { ...fallback, ...(usage ? { usage } : {}) };
    return { ...composed, generated: true, ...(usage ? { usage } : {}) };
  } catch {
    return { ...fallback, ...(usage ? { usage } : {}) };
  }
}

/** Books a generation turn's spend on the run's last agent step, so the run's usage shows it. */
export function recordPrDescribeUsage(
  store: {
    getRun(id: string): RunRecord | undefined;
    updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void;
    appendEvent(runId: string, event: { type: 'note'; message: string }): unknown;
  },
  runId: string,
  draft: PrDraft,
): void {
  const { usage } = draft;
  if (!usage) return;
  const run = store.getRun(runId);
  const step = run ? (lastAgentStep(run) ?? run.steps.filter((s) => s.kind === 'agent').at(-1)) : undefined;
  if (!step) return;
  store.updateStep(runId, step.id, {
    tokensUsed: step.tokensUsed + usage.tokensUsed,
    ...(usage.costUsd !== undefined ? { costUsd: (step.costUsd ?? 0) + usage.costUsd } : {}),
  });
  const cost = usage.costUsd !== undefined ? ` — $${usage.costUsd.toFixed(4)}` : '';
  store.appendEvent(runId, { type: 'note', message: `PR description ${draft.generated ? 'generated' : 'generation failed — using the handoff notes'}${cost}` });
}
