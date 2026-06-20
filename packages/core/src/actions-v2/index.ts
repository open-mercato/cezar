/**
 * Public entry point for the data-driven action runtime. Imported via
 * `@cezar/core` once exported from the package root in src/index.ts.
 */
export type {
  ActionDef,
  ActionTrigger,
  ActionRunResult,
  AcceptanceMode,
  AutoConfidenceConfig,
  HitlConfidenceConfig,
  ConfidenceConfig,
  EffectRoutingMode,
} from './action.js';
export type { ActionTarget, RunActionDeps, DeferredEffect, DeferSink } from './runner.js';
export { runAction } from './runner.js';
export {
  buildAutoCommentBody,
  actionAlreadyCommented,
  actionPreviouslyCommented,
  autoCommentTag,
  type BuildAutoCommentArgs,
} from './auto-comment.js';
export {
  EFFECT_REGISTRY,
  ALL_EFFECT_NAMES,
  executeEffect,
  effectsAsAnthropicTools,
  type EffectDef,
  type EffectCall,
  type EffectContext,
  type EffectName,
} from './effects.js';
export { formatOpenIssuesKb, type OpenIssueKbEntry } from './context-providers.js';
export { loadActionByName, loadAutoTriageAction, listEnabledActions } from './loader.js';
export { DEFAULT_ACTIONS } from './default-actions.js';
export {
  runTriagePass,
  type TriagePassOptions,
  type TriagePassActionResult,
  type TriagePassResult,
  type TriagePassDeferSink,
} from './triage-pass.js';
