import type { AuditFooterMeta } from '../services/audit.js';
import type { EffectCall } from './effects.js';

export interface BuildAutoCommentArgs {
  actionName: string;
  /** The model's free-form summary / final text — the "why". */
  text?: string;
  /** Effects the action applied — one short line each. */
  effectsApplied: ReadonlyArray<{ call: EffectCall; summary: string }>;
  /** Footer metadata. Only model + tokens are rendered; the rest is ignored. */
  meta: AuditFooterMeta;
}

/**
 * Builds the auto-comment body the action runner posts on the target after a
 * successful run. Minimal by design — one summary line, one line per applied
 * effect, a one-line provenance footer. The footer carries the stable
 * `Cezar · <action>` tag that `actionPreviouslyCommented` dedupes on.
 * Kept side-effect-free so the unit test can exercise the formatting.
 */
export function buildAutoCommentBody(args: BuildAutoCommentArgs): string {
  const text = (args.text ?? '').trim();
  const effects = args.effectsApplied;

  const summary =
    text.length > 0
      ? (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim()
      : effects.length > 0
        ? `Ran ${args.actionName} — applied ${effects.length} effect${effects.length === 1 ? '' : 's'}.`
        : `Ran ${args.actionName} — no changes applied.`;

  const lines: string[] = [summary];
  for (const e of effects) lines.push(`- ${e.summary}`);
  lines.push('', renderFooter(args.actionName, args.meta));
  return lines.join('\n');
}

function renderFooter(actionName: string, meta: AuditFooterMeta): string {
  const parts: string[] = [autoCommentTag(actionName)];
  if (meta.model) parts.push(meta.model);
  if (typeof meta.inputTokens === 'number' || typeof meta.outputTokens === 'number') {
    const inT = (meta.inputTokens ?? 0).toLocaleString('en-US');
    const outT = (meta.outputTokens ?? 0).toLocaleString('en-US');
    parts.push(`${inT} in / ${outT} out`);
  }
  return `🤖 *${parts.join(' · ')}*`;
}

/**
 * The runner skips the auto-comment when the action itself already posted
 * one via the `comment` effect (or an effect that internally calls
 * `addComment`, e.g. `link-duplicate`). Avoids double-commenting.
 */
const COMMENT_POSTING_EFFECTS = new Set<string>(['comment', 'link-duplicate']);

export function actionAlreadyCommented(
  effectsApplied: ReadonlyArray<{ call: EffectCall; summary: string }>,
): boolean {
  for (const e of effectsApplied) {
    if (COMMENT_POSTING_EFFECTS.has(e.call.effect)) return true;
  }
  return false;
}

/**
 * The stable per-action tag embedded in every auto-comment's footer
 * (`🤖 *Cezar · <name> · …*`). Used to dedupe against a prior run's comment
 * so re-running an action on an edited issue doesn't re-post the same
 * auto-comment. Comments from the pre-minimal format carried the same tag.
 */
export function autoCommentTag(actionName: string): string {
  return `Cezar · ${actionName}`;
}

/**
 * Cross-run dedupe: returns true when a previous run of this action already
 * left its auto-comment on the target. Scans fetched comment bodies for the
 * action's stable tag. Complements `actionAlreadyCommented`, which only sees
 * the *current* run's effects.
 */
export function actionPreviouslyCommented(
  actionName: string,
  comments: ReadonlyArray<{ body: string }>,
): boolean {
  const tag = autoCommentTag(actionName);
  return comments.some((c) => c.body.includes(tag));
}
