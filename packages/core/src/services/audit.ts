import type { GitHubService } from './github.service.js';

export interface AuditFooterMeta {
  /** The action name (e.g. `'auto-triage'`, `'security-labeler'`). */
  actionName?: string;
  /** Free-form label describing what initiated the run (e.g. `'cron · on-issue-opened'`). */
  triggeredBy?: string;
  /** Model used for the run (e.g. `'claude-sonnet-4-6'`). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Override the timestamp — defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

/**
 * Formats a standalone audit comment for actions that don't post
 * their own content (e.g. label-only operations).
 */
export function formatAuditComment(actions: string[]): string {
  const timestamp = new Date().toISOString();
  const actionList = actions.map((a) => `- ${a}`).join('\n');
  return `🤖 **CEZAR update** — ${timestamp}\n\n${actionList}`;
}

/**
 * Appends an audit footer to an existing comment body.
 *
 * Accepts either:
 *  - the legacy `string[]` form — renders the bulleted "what we did" list.
 *  - an `AuditFooterMeta` object — renders a single dot-separated metadata
 *    line (action · trigger · model · tokens · timestamp). Use this form
 *    for the action runner's auto-comment, where the bulleted list lives in
 *    the body and the footer is purely provenance.
 */
export function withAuditFooter(body: string, actions: string[]): string;
export function withAuditFooter(body: string, meta: AuditFooterMeta): string;
export function withAuditFooter(body: string, actionsOrMeta: string[] | AuditFooterMeta): string {
  if (Array.isArray(actionsOrMeta)) {
    const timestamp = new Date().toISOString();
    const actionList = actionsOrMeta.map((a) => `- ${a}`).join('\n');
    return `${body}\n\n---\n🤖 **CEZAR update** — ${timestamp}\n\n${actionList}`;
  }
  return `${body}\n\n---\n${renderMetaLine(actionsOrMeta)}`;
}

function renderMetaLine(meta: AuditFooterMeta): string {
  const ts = meta.timestamp ?? new Date().toISOString();
  const parts: string[] = ['Cezar'];
  if (meta.actionName) parts.push(meta.actionName);
  if (meta.triggeredBy) parts.push(meta.triggeredBy);
  if (meta.model) parts.push(meta.model);
  if (typeof meta.inputTokens === 'number' || typeof meta.outputTokens === 'number') {
    const inT = meta.inputTokens ?? 0;
    const outT = meta.outputTokens ?? 0;
    parts.push(`${formatNumber(inT)} in / ${formatNumber(outT)} out`);
  }
  parts.push(ts);
  return `🤖 *${parts.join(' · ')}*`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Posts a standalone audit comment on an issue.
 * Use this for actions that don't post their own comment (label-only, close-only).
 */
export async function postAuditComment(
  github: GitHubService,
  issueNumber: number,
  actions: string[],
): Promise<void> {
  const body = formatAuditComment(actions);
  await github.addComment(issueNumber, body);
}
