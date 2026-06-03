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
  /** LLM model the runner uses. Falls back to runner default when null. */
  model?: string | null;
  /** Acceptance routing. Defaults to 'auto' (apply every effect regardless of
   *  confidence). 'human-in-the-loop' routes low-confidence proposals to inbox. */
  acceptanceMode?: AcceptanceMode;
  /** Thresholds the runner uses to route per-effect confidence. */
  confidenceConfig?: ConfidenceConfig;
}

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

export type ActionTrigger =
  | 'manual'
  | 'on-issue-opened'
  | 'on-issue-edited'
  | 'on-issue-reopened'
  | 'on-pr-opened'
  | 'on-pr-edited'
  | 'on-comment'
  | 'on-check-failed'
  | 'on-cron';

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
