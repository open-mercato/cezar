import { z } from 'zod';
import type { Config } from '../../config/config.model.js';
import type { RootCause } from '../../actions/autofix/prompts/analyzer.js';
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
import {
  buildCiFollowupNotes,
  buildCiFollowupCommitMessage,
  buildCiFollowupPrComment,
  type CiFollowupTextInput,
} from '../../actions/autofix/messages.js';
import { agentStep, type Workflow, type WorkflowStep, type CommentSection } from '../workflow.js';

/**
 * The `ci-followup` workflow as data (docs §3.1). Triggered by a CI failure on
 * an already-opened autofix PR. Unlike `autofix` it starts from the existing PR
 * branch (no worktree-from-base, no analyzer): `attribute` → fix → commit →
 * review loop → push → PR comment. Re-expresses today's
 * `AutofixOrchestrator.processCiFollowup`; the orchestrator stays untouched.
 *
 * The `attribute` step is an effect (the attribution itself is computed by the
 * caller and threaded in via `config`-adjacent context — see
 * `CiFollowupSeedContext`); the blackboard carries it as the "root cause".
 */

// The caller seeds the run with the CI failure context (mirrors today's
// `CiFollowupInput`). The engine doesn't know about this shape; the workflow
// reads it off `config.__ciFollowup` (a transient field the caller sets).
export interface CiFollowupSeed extends CiFollowupTextInput {
  branch: string;
}

export interface CiFollowupBlackboard {
  /** Attribution recast as the root cause (confidence=1 — attributor already cleared "is this ours?"). */
  rootCause?: RootCause;
  /** The CI failure context, threaded from the caller's seed. */
  seed?: CiFollowupSeed;
  fixReport?: FixReport;
  diff?: string;
  commitSha?: string;
  verdict?: Required<ReviewVerdict>;
  retryNotes?: string;
  headSha?: string;
}

/** Read the CI follow-up seed off a transient config field the caller sets. */
function seedFrom(config: Config): CiFollowupSeed {
  const seed = (config as unknown as { __ciFollowup?: CiFollowupSeed }).__ciFollowup;
  if (!seed)
    throw new Error('ci-followup workflow requires config.__ciFollowup to be set by the caller');
  return seed;
}

function autofixCfg(config: Config): NonNullable<Config['autofix']> {
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

const attributeStep: WorkflowStep<CiFollowupBlackboard> = {
  id: 'attribute',
  kind: 'effect',
  builtinSkillId: 'attribute',
  // The attribution pipeline (ci-attribution.ts) is run by the caller before
  // dispatching this workflow — here we just recast it as the root cause that
  // the fixer/reviewer consume. (Future: this becomes an `agent` step when the
  // attributor moves behind the AgentRunner.)
  run: async (ctx) => {
    const seed = seedFrom(ctx.config);
    const rootCause: RootCause = {
      summary: seed.attribution.suggestedFocus
        ? `CI follow-up: ${seed.attribution.suggestedFocus}`
        : `CI failure on PR #${seed.prNumber} attributed to this autofix`,
      hypothesis: seed.attribution.reasoning,
      suspectedFiles: [],
      reproductionNotes:
        seed.failedCheckNames.length > 0
          ? `Failing CI checks: ${seed.failedCheckNames.join(', ')}`
          : undefined,
      confidence: 1,
    };
    return { kind: 'continue', blackboardPatch: { rootCause, seed } };
  },
  commentSection: (ctx): CommentSection => {
    const seed = ctx.blackboard.seed;
    if (!seed) return null;
    return {
      heading: '🧭 CI failure attributed to this autofix',
      body: `${seed.attribution.reasoning}${seed.attribution.suggestedFocus ? `\n\n**Focus:** ${seed.attribution.suggestedFocus}` : ''}`,
    };
  },
};

const fixStep: WorkflowStep<CiFollowupBlackboard> = agentStep<CiFollowupBlackboard, FixReport>({
  id: 'fix',
  kind: 'agent',
  builtinSkillId: 'fix',
  builtinSystemPrompt: FIXER_SYSTEM_PROMPT,
  builtinModel: (cfg) => autofixCfg(cfg).models.fixer,
  builtinTools: (cfg) => autofixCfg(cfg).allowedTools,
  bashAllowlist: (cfg) => autofixCfg(cfg).bashAllowlist,
  maxTurns: (cfg) => autofixCfg(cfg).maxTurns.fixer,
  responseSchema: FixReportSchema,
  cwdRequired: true,
  buildUserPrompt: (ctx) => {
    const rc = ctx.blackboard.rootCause;
    const seed = ctx.blackboard.seed;
    if (!rc || !seed)
      throw new Error('ci-followup fix ran without root cause / seed on the blackboard');
    return buildFixerUserPrompt({
      issueNumber: ctx.issue.number,
      title: ctx.issue.title,
      rootCause: rc,
      priorAttemptNotes: ctx.blackboard.retryNotes ?? buildCiFollowupNotes(seed),
    });
  },
  onResult: (parsed) => ({ kind: 'continue', blackboardPatch: { fixReport: parsed } }),
  commentSection: (parsed): CommentSection => ({
    heading: '🔧 CI follow-up fix',
    body: `${parsed.approach}\n\nFiles: ${parsed.changedFiles.map((f) => `\`${f}\``).join(', ') || '_(none reported)_'}`,
  }),
});

const commitStep: WorkflowStep<CiFollowupBlackboard> = {
  id: 'commit',
  kind: 'commit',
  builtinSkillId: 'commit',
  // For CI follow-up, no changes ⇒ skip-run (the failure may no longer reproduce).
  failOnNoChanges: false,
  buildMessage: (ctx) => {
    const fr = ctx.blackboard.fixReport;
    const seed = ctx.blackboard.seed;
    if (!fr || !seed)
      throw new Error('ci-followup commit ran without fix report / seed on the blackboard');
    return buildCiFollowupCommitMessage(seed, ctx.issue.title, fr);
  },
  onCommitted: (info) => ({
    kind: 'continue',
    blackboardPatch: { commitSha: info.commitSha, diff: info.diff },
  }),
};

const reviewStep: WorkflowStep<CiFollowupBlackboard> = agentStep<
  CiFollowupBlackboard,
  ReviewVerdict
>({
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
      throw new Error('ci-followup review ran without root cause / fix report on the blackboard');
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
        reason: `CI follow-up review ${verdict.verdict} (${blockers} blocker(s))`,
        retriable: cfg.retryOnReviewFailure,
        blackboardPatch: { verdict, retryNotes: retryNotesFromVerdict(verdict) },
      };
    }
    return { kind: 'continue', blackboardPatch: { verdict } };
  },
  onNoParse: (rawText, ctx) => {
    const cfg = autofixCfg(ctx.config);
    const verdict = fallbackVerdictFromProse(rawText);
    if (!reviewPasses(cfg, verdict)) {
      return {
        kind: 'fail',
        reason: `reviewer emitted prose; recovered verdict=${verdict.verdict}`,
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
    heading: '🔁 CI follow-up review failed — retrying',
    body: reason,
  }),
});

const pushStep: WorkflowStep<CiFollowupBlackboard> = {
  id: 'push',
  kind: 'push',
  builtinSkillId: 'push',
  prCommentSection: (ctx): CommentSection => {
    const seed = ctx.blackboard.seed;
    const fr = ctx.blackboard.fixReport;
    const v = ctx.blackboard.verdict;
    if (!seed || !fr || !v) return null;
    return { heading: 'CI follow-up pushed', body: buildCiFollowupPrComment(seed, fr, v) };
  },
  onPushed: (info) => ({ kind: 'continue', blackboardPatch: { headSha: info.headSha } }),
};

// ─── Workflow ───────────────────────────────────────────────────────────────

export const ciFollowupWorkflow: Workflow<CiFollowupBlackboard> = {
  id: 'ci-followup',
  title: 'CI follow-up',
  // CI follow-up always operates on the PR — the engine seeds `prNumber` from
  // the run context, so the living comment goes straight to the PR.
  commentTargetOrder: ['pr'],
  initialBlackboard: () => ({}),
  steps: [attributeStep, fixStep, commitStep, reviewStep, pushStep],
  // The orchestrator's `processCiFollowup` does not retry internally — one
  // attempt per call, the CI-fix cron loops if attempts remain. So the default
  // loop cap is 1 (review-fail ⇒ run fails); the caller can raise it via
  // `loopMaxIterations: { 'fix-review': N }` if they want in-run retries.
  loops: [
    {
      id: 'fix-review',
      stepIds: ['fix', 'commit', 'review'],
      until: (ctx) => ctx.blackboard.verdict?.verdict === 'pass',
      maxIterations: 1,
    },
  ],
};
