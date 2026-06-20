import type Anthropic from '@anthropic-ai/sdk';
import type { GitHubService } from '../services/github.service.js';
import type { WorkspaceLabel } from '../labels/label-catalog.js';
import { discoverBuiltinSkills, type Skill } from '../skills/skill-catalog.js';
import type { ActionDef, ActionTrigger } from './action.js';
import type { EffectCall, EffectContext } from './effects.js';
import { listEnabledActions, loadAutoTriageAction } from './loader.js';
import { runAction, type ActionTarget, type DeferredEffect } from './runner.js';

/** Per-action context handed to a triage-pass deferSink so the caller has
 *  everything it needs to write a `pending_decisions` row. */
export type TriagePassDeferSink = (
  item: DeferredEffect & { action: ActionDef; target: ActionTarget },
) => Promise<void>;

export interface TriagePassOptions {
  workspaceId: string;
  issueNumber: number;
  /** Pre-formatted target — caller fetches the issue and shapes it. */
  target: ActionTarget;
  supabase: unknown;
  github: GitHubService;
  /** Which trigger initiated this pass (e.g. `'on-issue-opened'`). */
  trigger: ActionTrigger;
  /** Resolved skill catalog — defaults to the built-in catalog. */
  skills?: Skill[];
  /** Anthropic client override (testing); the runner builds one from env otherwise. */
  anthropic?: Anthropic;
  /** Forwarded to every `runAction` call in the pass. The same `triggeredBy`
   *  label is reused for each action so the audit footer reads consistently. */
  autoComment?: { enabled: boolean; triggeredBy?: string };
  /** Receives every effect that the runner deferred to human review. Wired
   *  by the GUI dispatch layer to insert into `pending_decisions`. */
  deferSink?: TriagePassDeferSink;
  /** Workspace label catalog — forwarded into each action's `runAction` call
   *  so the per-action system message includes the catalog (see runner.ts). */
  labels?: WorkspaceLabel[];
  /** Context-provider map forwarded to every `runAction` call — resolved
   *  per-action against each action's `contextRefs` (see runner.ts). */
  contextProviders?: Record<string, () => Promise<string>>;
}

/** Per-action result from a triage pass. */
export interface TriagePassActionResult {
  actionName: string;
  ok: boolean;
  text: string;
  effectsApplied: Array<{ call: EffectCall; summary: string }>;
  error?: string;
}

export interface TriagePassResult {
  results: TriagePassActionResult[];
  totalUsage: { inputTokens: number; outputTokens: number };
}

/**
 * Run the data-driven triage pass for one issue. The auto-triage action (if
 * configured via `workspaces.auto_triage_action_id`) runs first, followed by
 * every other enabled action whose `target` matches and whose `triggers`
 * contain the supplied trigger — sorted by name for deterministic ordering.
 *
 * Per-action failures are caught and recorded — one action throwing does NOT
 * abort the whole pass. The auto-triage action is excluded from the
 * trigger-matched list so it never runs twice in a single pass.
 */
export async function runTriagePass(opts: TriagePassOptions): Promise<TriagePassResult> {
  const skills = opts.skills ?? (await discoverBuiltinSkills());
  const effectCtx: EffectContext = {
    github: opts.github,
    targetNumber: opts.issueNumber,
    supabase: opts.supabase,
    workspaceId: opts.workspaceId,
  };

  const autoTriage = await loadAutoTriageAction(opts.supabase, opts.workspaceId).catch((err) => {
    console.error(
      '[triage-pass] loadAutoTriageAction failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  });

  const matched = await listEnabledActions(opts.supabase, opts.workspaceId, {
    target: opts.target.kind,
    trigger: opts.trigger,
  }).catch((err) => {
    console.error(
      '[triage-pass] listEnabledActions failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  });

  const ordered = [
    ...(autoTriage ? [autoTriage] : []),
    ...matched.filter((a) => a.id !== autoTriage?.id),
  ];

  const results: TriagePassActionResult[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const action of ordered) {
    // Wrap the caller's sink to capture per-action context the GUI needs.
    const innerDeferSink = opts.deferSink
      ? async (item: DeferredEffect) => opts.deferSink!({ ...item, action, target: opts.target })
      : undefined;
    try {
      const res = await runAction(action, opts.target, {
        skills,
        anthropic: opts.anthropic,
        effectCtx,
        autoComment: opts.autoComment,
        deferSink: innerDeferSink,
        labels: opts.labels,
        contextProviders: opts.contextProviders,
      });
      results.push({
        actionName: action.name,
        ok: true,
        text: res.text,
        effectsApplied: res.effectsApplied,
      });
      inputTokens += res.usage.inputTokens;
      outputTokens += res.usage.outputTokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        actionName: action.name,
        ok: false,
        text: '',
        effectsApplied: [],
        error: message,
      });
    }
  }

  return { results, totalUsage: { inputTokens, outputTokens } };
}
