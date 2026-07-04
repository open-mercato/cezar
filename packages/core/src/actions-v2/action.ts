import type { EffectCall, EffectName } from './effects.js';

/**
 * The data-driven Action that replaces the legacy TypeScript action plugins.
 *
 *   - `system_prompt` is the operative instruction sent as the Anthropic
 *     system message.
 *   - `skill_refs` names skills (built-in, repo, or override) whose markdown
 *     body is concatenated into the system message ahead of the prompt — so
 *     skills are the reusable building blocks and the action is the
 *     invocation.
 *   - `effects` declares the side-effect contract. When `null`, the runner
 *     exposes the effect vocabulary to the agent as Anthropic tools and the
 *     agent calls them itself.
 *   - `output_schema` is enforced ONLY when `effects` is non-null — the
 *     model's response is parsed against this schema and the resulting
 *     `EffectCall[]` is executed in order.
 */
export interface ActionDef {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  systemPrompt: string;
  skillRefs: string[];
  target: 'issue' | 'pr';
  triggers: ActionTrigger[];
  effects: EffectName[] | null;
  outputSchema: Record<string, unknown> | null;
  enabled: boolean;
  /** Named context sections the runner injects into the user message — each
   *  ref resolves against `RunActionDeps.contextProviders` (e.g. 'open-issues'
   *  → the open-issue knowledge base). Unresolvable refs are skipped. */
  contextRefs?: string[];
  /** LLM model the runner uses. Falls back to runner default when null. */
  model?: string | null;
  /** Acceptance routing. Defaults to 'auto' (apply every effect regardless of
   *  confidence). 'human-in-the-loop' routes low-confidence proposals to inbox. */
  acceptanceMode?: AcceptanceMode;
  /** Thresholds the runner uses to route per-effect confidence. */
  confidenceConfig?: ConfidenceConfig;
  /** Per-effect routing override, checked BEFORE the confidence thresholds:
   *  'always-defer' sends the effect to the review inbox regardless of
   *  confidence (dropped when no defer sink is wired); 'auto' applies it
   *  unconditionally. Absent entries fall through to the confidence logic
   *  (with a built-in default of 'always-defer' for `suggest-workflow`). */
  effectRouting?: Partial<Record<EffectName, EffectRoutingMode>>;
  /** The workflow (`flows` row id) this action may suggest running on its
   *  target via the `suggest-workflow` effect. null/absent = the
   *  suggest-workflow tool is not exposed to the model at all. */
  suggestedFlowId?: string | null;
}

/** Routing override values for `ActionDef.effectRouting`. */
export type EffectRoutingMode = 'auto' | 'always-defer';

export type AcceptanceMode = 'auto' | 'human-in-the-loop';

/** Auto mode: ≥ autoAcceptAbove → apply; < → drop. */
export interface AutoConfidenceConfig {
  autoAcceptAbove: number;
}

/** HITL mode: ≥ autoAcceptAbove → apply; in band → defer to inbox; < autoDenyBelow → drop. */
export interface HitlConfidenceConfig {
  autoAcceptAbove: number;
  autoDenyBelow: number;
}

export type ConfidenceConfig = AutoConfidenceConfig | HitlConfidenceConfig;

/**
 * Default `autoAcceptAbove` threshold used when an action's `confidence_config`
 * is absent or malformed. A model that explicitly self-reports confidence below
 * this bar is no longer auto-applied; effects that emit no confidence at all are
 * still treated as fully confident (see the runner's `applyOrDefer`), preserving
 * legacy actions that never emit confidence.
 */
export const DEFAULT_AUTO_ACCEPT_ABOVE = 80;

/**
 * Triggers that can actually fire today (Phase 4 — trigger honesty). The
 * webhook derives the `on-issue-*` values from the GitHub `issues` event
 * action; `manual` is the "run now" path. Re-add entries (e.g. `on-cron`,
 * `on-pr-opened`) only when a real firing path ships.
 */
export type ActionTrigger = 'manual' | 'on-issue-opened' | 'on-issue-edited' | 'on-issue-reopened';

/** Output of a successful action run. */
export interface ActionRunResult {
  /** Free-form text the model produced (the "final assistant message"). */
  text: string;
  /** Side-effects that fired during/after the run, in execution order. */
  effectsApplied: Array<{ call: EffectCall; summary: string }>;
  /** Approximate token usage, for cost accounting. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}
