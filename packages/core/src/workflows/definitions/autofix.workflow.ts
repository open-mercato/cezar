import { z } from 'zod';
import type { Config } from '../../config/config.model.js';
import {
  ANALYZER_SYSTEM_PROMPT,
  AnalyzerResultSchema,
  isNoActionNeeded,
  buildAnalyzerUserPrompt,
  type RootCause,
} from '../../actions/autofix/prompts/analyzer.js';
import {
  FIXER_SYSTEM_PROMPT,
  FixReportSchema,
  buildFixerUserPrompt,
  type FixReport,
} from '../../actions/autofix/prompts/fixer.js';
import {
  REVIEWER_SYSTEM_PROMPT,
  ReviewVerdictSchema,
  buildReviewerUserPrompt,
  normalizeVerdict,
  retryNotesFromVerdict,
  fallbackVerdictFromProse,
  type ReviewVerdict,
} from '../../actions/autofix/prompts/reviewer.js';
import { buildCommitMessage, buildPrBody } from '../../actions/autofix/messages.js';
import { normalizeTitle } from '../../actions/autofix/prompts/untrusted.js';
import { AGENT_EXECUTION_GUIDANCE } from '../../actions/autofix/prompts/agent-guidance.js';
import { agentStep, type Workflow, type WorkflowStep, type CommentSection } from '../workflow.js';
import { tailLines, type ShellResult } from '../../provision/run-env.js';

/**
 * The `autofix` workflow as data:
 *   verify-in-repo → [confirm-fix gate] → root-cause → fix → commit → review
 *   → loop(fix,commit,review until verdict pass, maxIterations) → open-pr
 */

// ─── verify-in-repo (NEW lightweight gate) ──────────────────────────────────
// Conceptually folds the orchestrator's `runAlreadyFixedPreflight` done-detector
// check + the analyzer's `noActionNeeded` exit. Phase 2 only does the LLM gate
// (read-only stance, repo checked out) — TODO(phase-2): also fold the merged-PR
// timeline preflight in here.

export const VerifyInRepoSchema = z.object({
  isRealUnfixedDefect: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type VerifyInRepo = z.infer<typeof VerifyInRepoSchema>;

const VERIFY_IN_REPO_SYSTEM_PROMPT = `You are the VERIFY-IN-REPO agent. With the repository checked out, decide whether the reported issue is a *real, still-unfixed defect* — as opposed to expected behavior, an issue that is already fixed on this branch, or something that is not actually a bug.

RULES:
- You have READ-ONLY tools (Read, Grep, Glob, and read-only Bash like \`git log\`, \`git diff\`, \`git show\`, \`git status\`).
- Do NOT edit any files.
- Be quick: this is a triage gate, not a full root-cause analysis. Stop as soon as you can defend a yes/no.
- Look for: a recent commit that already fixed it; a test that already covers it; documented/intentional behavior; an environment/usage error on the reporter's side.
- Do NOT search the repo for skill/doc files. Everything you need is in this prompt.

OUTPUT — output ONLY a single JSON object (no markdown fences, no prose):
{
  "isRealUnfixedDefect": true | false,
  "reason": "one short paragraph. Cite commit hashes, file paths, or test names as evidence.",
  "confidence": 0.0 to 1.0
}${AGENT_EXECUTION_GUIDANCE}`;

// ─── Blackboard ─────────────────────────────────────────────────────────────

export interface AutofixBlackboard {
  verify?: VerifyInRepo;
  rootCause?: RootCause;
  fixReport?: FixReport;
  /** Diff against base after the latest commit (set by the `commit` step). */
  diff?: string;
  commitSha?: string;
  /** Normalized review verdict; `verdict.verdict === 'pass'` is the loop exit. */
  verdict?: Required<ReviewVerdict>;
  /** Reviewer blocker notes (and/or build/test failure tails) carried into the next fix iteration. */
  retryNotes?: string;
  /** Latest install / build / test results (set by the shell-check steps). */
  installResult?: ShellResult;
  buildResult?: ShellResult;
  testResult?: ShellResult;
  /** Dev server URL once booted (set by the dev-server step). */
  devServerUrl?: string;
  prUrl?: string;
  prNumber?: number;
  headSha?: string;
}

function autofixCfg(config: Config): NonNullable<Config['autofix']> {
  // The engine only runs this workflow when autofix config is present; the
  // zod schema always supplies defaults so this is non-null in practice.
  return config.autofix as NonNullable<Config['autofix']>;
}

function reviewPasses(
  cfg: NonNullable<Config['autofix']>,
  verdict: Required<ReviewVerdict>,
): boolean {
  const blockers = verdict.issues.filter((iss) => iss.severity === 'blocker').length;
  return cfg.requireReviewPass ? verdict.verdict === 'pass' && blockers === 0 : blockers === 0;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

const verifyInRepoStep: WorkflowStep<AutofixBlackboard> = agentStep<
  AutofixBlackboard,
  VerifyInRepo
>({
  id: 'verify-in-repo',
  kind: 'agent',
  builtinSkillId: 'verify-in-repo',
  builtinSystemPrompt: VERIFY_IN_REPO_SYSTEM_PROMPT,
  builtinModel: (cfg) => autofixCfg(cfg).models.reviewer,
  builtinTools: ['Read', 'Grep', 'Glob', 'Bash'],
  bashAllowlist: [
    'git log',
    'git diff',
    'git show',
    'git status',
    'gh issue edit',
    'gh issue view',
    'gh pr edit',
    'gh pr view',
  ],
  maxTurns: (cfg) => autofixCfg(cfg).maxTurns.reviewer,
  responseSchema: VerifyInRepoSchema,
  cwdRequired: true,
  labelScope: 'issue',
  buildUserPrompt: (ctx) => {
    const lines = [`ISSUE #${ctx.issue.number}: ${ctx.issue.title}`, ''];
    if (ctx.issue.digest) {
      lines.push(
        `DIGEST: ${ctx.issue.digest.summary} (area: ${ctx.issue.digest.affectedArea})`,
        '',
      );
    }
    lines.push('BODY:', ctx.issue.body.slice(0, 4000), '');
    if (ctx.issue.comments.length > 0) {
      lines.push('RECENT COMMENTS:');
      for (const c of ctx.issue.comments.slice(-5)) {
        lines.push(`@${c.author} (${c.createdAt}): ${c.body.slice(0, 600)}`);
      }
      lines.push('');
    }
    lines.push('Decide whether this is a real, still-unfixed defect and produce the JSON object.');
    return lines.join('\n');
  },
  onResult: (parsed, ctx) => {
    const cfg = autofixCfg(ctx.config);
    if (!parsed.isRealUnfixedDefect) {
      return { kind: 'skip-run', reason: parsed.reason };
    }
    if (parsed.confidence < cfg.minAnalyzerConfidence) {
      return {
        kind: 'skip-run',
        reason: `verify-in-repo confidence ${parsed.confidence.toFixed(2)} below threshold ${cfg.minAnalyzerConfidence}`,
      };
    }
    return { kind: 'continue', blackboardPatch: { verify: parsed } };
  },
  commentSection: (parsed): CommentSection => ({
    heading: '✅ Verified in repo',
    body: parsed.reason,
  }),
});

const confirmFixGate: WorkflowStep<AutofixBlackboard> = {
  id: 'confirm-fix',
  kind: 'human-gate',
  builtinSkillId: 'confirm-fix',
  buildPrompt: (ctx) => ({
    stepId: 'confirm-fix',
    question: `Proceed with an automated fix for #${ctx.issue.number} (${ctx.issue.title})?`,
    options: ['proceed', 'skip'],
    context: { verify: ctx.blackboard.verify },
  }),
  // Auto-proceed when verify-in-repo confidence cleared the threshold and a
  // human callback isn't wired (the generalization of `confirmBeforeFix`
  // being undefined — i.e. CI mode). When a callback IS wired the engine asks.
  autoProceed: (ctx) => {
    const cfg = autofixCfg(ctx.config);
    const conf = ctx.blackboard.verify?.confidence ?? 0;
    return conf >= cfg.minAnalyzerConfidence;
  },
  onDecision: (decision) =>
    decision.choice === 'proceed'
      ? { kind: 'continue' }
      : { kind: 'skip-run', reason: 'maintainer declined the automated fix' },
  commentSection: (): CommentSection => ({
    heading: '⏸ Maintainer go-ahead',
    body: 'Proceeding with the automated fix.',
  }),
};

// ─── shell-check steps (install / build / test) ─────────────────────────────
// Run only when the workspace configured a runnable project env (and the run
// has a `RunEnv`). Otherwise the engine skips them, so behavior is unchanged.

function shellCommentSection(label: string, result: ShellResult): CommentSection {
  const out = tailLines(`${result.stdout}\n${result.stderr}`, 30);
  return {
    heading: result.ok ? `✅ ${label} passed` : `❌ ${label} failed (exit ${result.exitCode})`,
    body: out ? `\`\`\`\n${out}\n\`\`\`` : '_(no output)_',
  };
}

/** Build the fixer retry note from a failing build/test result. */
function failureRetryNote(label: string, prior: string | undefined, result: ShellResult): string {
  const tail = tailLines(`${result.stdout}\n${result.stderr}`, 40);
  const note = `The ${label} step failed (exit ${result.exitCode}). Fix the underlying cause. Output tail:\n${tail}`;
  return prior ? `${prior}\n\n${note}` : note;
}

const installStep: WorkflowStep<AutofixBlackboard> = {
  id: 'install',
  kind: 'shell-check',
  builtinSkillId: 'install',
  which: 'install',
  gate: (cfg) => autofixCfg(cfg).projectEnv.gateOnInstall,
  // Install runs once before root-cause; a gated failure is terminal (not in the loop).
  retriable: false,
  onResult: (result) => ({ installResult: result }),
  // Setup-phase step — intentionally no `commentSection` so install output
  // doesn't clutter the issue/PR. Status/output is still visible in the cockpit.
};

const buildStep: WorkflowStep<AutofixBlackboard> = {
  id: 'build',
  kind: 'shell-check',
  builtinSkillId: 'build',
  which: 'build',
  gate: (cfg) => autofixCfg(cfg).projectEnv.gateOnBuild,
  retriable: true,
  onResult: (result, ctx) =>
    result.ok
      ? { buildResult: result }
      : {
          buildResult: result,
          retryNotes: failureRetryNote('build', ctx.blackboard.retryNotes, result),
        },
  commentSection: (result): CommentSection => shellCommentSection('Build', result),
};

const testStep: WorkflowStep<AutofixBlackboard> = {
  id: 'test',
  kind: 'shell-check',
  builtinSkillId: 'test',
  which: 'test',
  gate: (cfg) => autofixCfg(cfg).projectEnv.gateOnTest,
  retriable: true,
  onResult: (result, ctx) =>
    result.ok
      ? { testResult: result }
      : {
          testResult: result,
          retryNotes: failureRetryNote('test', ctx.blackboard.retryNotes, result),
        },
  commentSection: (result): CommentSection => shellCommentSection('Tests', result),
};

// Boot the dev server (if configured) after install, before diagnosis, so
// root-cause / fix can probe the live app via curl. Torn down with the run env.
const devServerStep: WorkflowStep<AutofixBlackboard> = {
  id: 'dev-server',
  kind: 'dev-server',
  builtinSkillId: 'dev-server',
  // Informational: don't fail the run if the server is slow to come up.
  gate: false,
  onReady: (info) => ({ devServerUrl: info.url }),
  // Setup-phase step — intentionally no `commentSection`. The URL is still
  // injected into later agent prompts; the cockpit shows boot status.
};

const rootCauseStep: WorkflowStep<AutofixBlackboard> = agentStep<
  AutofixBlackboard,
  z.infer<typeof AnalyzerResultSchema>
>({
  id: 'root-cause',
  kind: 'agent',
  builtinSkillId: 'root-cause',
  builtinSystemPrompt: ANALYZER_SYSTEM_PROMPT,
  builtinModel: (cfg) => autofixCfg(cfg).models.analyzer,
  builtinTools: ['Read', 'Grep', 'Glob', 'Bash'],
  bashAllowlist: [
    'git log',
    'git diff',
    'git show',
    'git status',
    'gh issue edit',
    'gh issue view',
    'gh pr edit',
    'gh pr view',
  ],
  maxTurns: (cfg) => autofixCfg(cfg).maxTurns.analyzer,
  responseSchema: AnalyzerResultSchema,
  cwdRequired: true,
  labelScope: 'issue',
  buildUserPrompt: (ctx) =>
    buildAnalyzerUserPrompt({
      issueNumber: ctx.issue.number,
      title: ctx.issue.title,
      body: ctx.issue.body,
      comments: ctx.issue.comments,
      digest: ctx.issue.digest,
      priorAttemptNotes: ctx.blackboard.retryNotes,
    }),
  onResult: (parsed, ctx) => {
    const cfg = autofixCfg(ctx.config);
    if (isNoActionNeeded(parsed)) {
      return { kind: 'skip-run', reason: parsed.reason };
    }
    if (parsed.confidence < cfg.minAnalyzerConfidence) {
      return {
        kind: 'fail',
        reason: `analyzer confidence ${parsed.confidence.toFixed(2)} below threshold ${cfg.minAnalyzerConfidence}`,
        blackboardPatch: { rootCause: parsed },
      };
    }
    return { kind: 'continue', blackboardPatch: { rootCause: parsed } };
  },
  commentSection: (parsed): CommentSection =>
    isNoActionNeeded(parsed)
      ? { heading: 'ℹ️ No action needed', body: parsed.reason }
      : { heading: '✅ Root cause', body: `${parsed.summary}\n\n${parsed.hypothesis}` },
});

const fixStep: WorkflowStep<AutofixBlackboard> = agentStep<AutofixBlackboard, FixReport>({
  id: 'fix',
  kind: 'agent',
  builtinSkillId: 'fix',
  builtinSystemPrompt: FIXER_SYSTEM_PROMPT,
  builtinModel: (cfg) => autofixCfg(cfg).models.fixer,
  // Config-driven, exactly as today's orchestrator reads them.
  builtinTools: (cfg) => autofixCfg(cfg).allowedTools,
  bashAllowlist: (cfg) => autofixCfg(cfg).bashAllowlist,
  maxTurns: (cfg) => autofixCfg(cfg).maxTurns.fixer,
  responseSchema: FixReportSchema,
  cwdRequired: true,
  buildUserPrompt: (ctx) => {
    const rc = ctx.blackboard.rootCause;
    if (!rc) throw new Error('fix step ran without a root cause on the blackboard');
    return buildFixerUserPrompt({
      issueNumber: ctx.issue.number,
      title: ctx.issue.title,
      rootCause: rc,
      priorAttemptNotes: ctx.blackboard.retryNotes,
    });
  },
  onResult: (parsed) => ({ kind: 'continue', blackboardPatch: { fixReport: parsed } }),
  commentSection: (parsed): CommentSection => ({
    heading: '🔧 Fix',
    body: `${parsed.approach}\n\nFiles: ${parsed.changedFiles.map((f) => `\`${f}\``).join(', ') || '_(none reported)_'}`,
  }),
});

const commitStep: WorkflowStep<AutofixBlackboard> = {
  id: 'commit',
  kind: 'commit',
  builtinSkillId: 'commit',
  failOnNoChanges: true,
  buildMessage: (ctx) => {
    const fr = ctx.blackboard.fixReport;
    if (!fr) throw new Error('commit step ran without a fix report on the blackboard');
    return buildCommitMessage(ctx.issue.number, ctx.issue.title, fr);
  },
  onCommitted: (info) => ({
    kind: 'continue',
    blackboardPatch: { commitSha: info.commitSha, diff: info.diff },
  }),
};

const reviewStep: WorkflowStep<AutofixBlackboard> = agentStep<AutofixBlackboard, ReviewVerdict>({
  id: 'review',
  kind: 'agent',
  builtinSkillId: 'review',
  builtinSystemPrompt: REVIEWER_SYSTEM_PROMPT,
  builtinModel: (cfg) => autofixCfg(cfg).models.reviewer,
  builtinTools: ['Read', 'Grep', 'Glob'],
  maxTurns: (cfg) => autofixCfg(cfg).maxTurns.reviewer,
  responseSchema: ReviewVerdictSchema,
  cwdRequired: true,
  buildUserPrompt: (ctx) => {
    const rc = ctx.blackboard.rootCause;
    const fr = ctx.blackboard.fixReport;
    if (!rc || !fr)
      throw new Error('review step ran without root cause / fix report on the blackboard');
    return buildReviewerUserPrompt({
      issueNumber: ctx.issue.number,
      title: ctx.issue.title,
      rootCause: rc,
      fixReport: fr,
      diff: ctx.blackboard.diff ?? '',
      baseBranch: autofixCfg(ctx.config).baseBranch,
    });
  },
  onResult: (parsed, ctx) => {
    const cfg = autofixCfg(ctx.config);
    const verdict = normalizeVerdict(parsed);
    if (!reviewPasses(cfg, verdict)) {
      const blockers = verdict.issues.filter((iss) => iss.severity === 'blocker').length;
      return {
        kind: 'fail',
        reason: `review ${verdict.verdict} (${blockers} blocker(s))`,
        retriable: cfg.retryOnReviewFailure,
        blackboardPatch: { verdict, retryNotes: retryNotesFromVerdict(verdict) },
      };
    }
    return { kind: 'continue', blackboardPatch: { verdict } };
  },
  // Reviewer emitted prose instead of JSON — recover what we can so the loop
  // keeps its signal (mirrors the orchestrator's fallbackVerdictFromProse).
  onNoParse: (rawText, ctx) => {
    const cfg = autofixCfg(ctx.config);
    const verdict = fallbackVerdictFromProse(rawText);
    if (!reviewPasses(cfg, verdict)) {
      const blockers = verdict.issues.filter((iss) => iss.severity === 'blocker').length;
      return {
        kind: 'fail',
        reason: `reviewer emitted prose; recovered verdict=${verdict.verdict} with ${blockers} blocker(s)`,
        retriable: cfg.retryOnReviewFailure,
        blackboardPatch: { verdict, retryNotes: retryNotesFromVerdict(verdict) },
      };
    }
    return { kind: 'continue', blackboardPatch: { verdict } };
  },
  commentSection: (parsed): CommentSection => {
    const v = normalizeVerdict(parsed);
    return { heading: `🔎 Review — verdict \`${v.verdict}\``, body: v.summary };
  },
  failCommentSection: (reason): CommentSection => ({
    heading: '🔁 Review failed — retrying',
    body: reason,
  }),
});

const openPrStep: WorkflowStep<AutofixBlackboard> = {
  id: 'open-pr',
  kind: 'open-pr',
  builtinSkillId: 'open-pr',
  buildPr: (ctx) => {
    const rc = ctx.blackboard.rootCause;
    const fr = ctx.blackboard.fixReport;
    const v = ctx.blackboard.verdict;
    if (!rc || !fr || !v)
      throw new Error('open-pr ran without root cause / fix report / verdict on the blackboard');
    return {
      title: `fix: ${normalizeTitle(ctx.issue.title)} (#${ctx.issue.number})`,
      body: buildPrBody(ctx.issue.number, rc, fr, v),
    };
  },
  prCommentSection: (ctx): CommentSection => {
    const rc = ctx.blackboard.rootCause;
    const fr = ctx.blackboard.fixReport;
    const v = ctx.blackboard.verdict;
    if (!rc || !fr || !v) return null;
    return {
      heading: '🤖 Cezar autofix summary',
      body: `**Root cause:** ${rc.summary}\n\n${rc.hypothesis}\n\n**Approach:** ${fr.approach}\n\n**Automated review:** \`${v.verdict}\` — ${v.summary}\n\nThis is a draft PR — a human reviewer must confirm correctness before it merges.`,
    };
  },
  onOpened: (info) => ({
    kind: 'continue',
    blackboardPatch: { prUrl: info.url, prNumber: info.number, headSha: info.headSha },
  }),
};

// ─── Workflow ───────────────────────────────────────────────────────────────

export const autofixWorkflow: Workflow<AutofixBlackboard> = {
  id: 'autofix',
  title: 'Autofix',
  commentTargetOrder: ['issue', 'pr'],
  initialBlackboard: () => ({}),
  steps: [
    verifyInRepoStep,
    confirmFixGate,
    installStep,
    devServerStep,
    rootCauseStep,
    fixStep,
    commitStep,
    buildStep,
    testStep,
    reviewStep,
    openPrStep,
  ],
  // fix↔commit↔build↔test↔review loop until the reviewer passes; a gated build
  // or test failure short-circuits back to fix (carrying the failure tail as
  // retry notes) before the reviewer ever sees the diff. maxIterations mirrors
  // today's `cfg.autofix.maxAttemptsPerIssue` (the engine clamps to ≥1).
  loops: [
    {
      id: 'fix-review',
      stepIds: ['fix', 'commit', 'build', 'test', 'review'],
      until: (ctx) => ctx.blackboard.verdict?.verdict === 'pass',
      maxIterations: 2,
    },
  ],
};
