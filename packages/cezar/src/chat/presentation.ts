import type { WebhookCompletionReason } from '@open-mercato/cezar-contract';
const statusLabels: Record<string, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting for your answer', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', review: 'Ready for review', expired: 'Expired' };
/** Human status names shared by notifications and bot replies; unknown codes never leak. */
export const readableTaskStatus = (status: string): string => statusLabels[status] ?? 'Status unavailable';
/** The `Repository:` line of a finished task: what happened to the code, never the agent's answer.
 *  `completed` and `unknown` say nothing beyond the status, so they have no line. */
export const readableCompletionReason: Record<WebhookCompletionReason, string | undefined> = {
  pr_opened: 'Pull request opened', accepted: 'Changes accepted', no_changes: 'Unchanged', completed: undefined, unknown: undefined,
};
type Question = { question: string; options?: Array<{ label: string; description?: string }> };
type Links = { pullRequest?: string; issue?: string; cockpit?: string };
export interface TaskReply {
  id: string; title: string; status: string; result?: string; error?: string;
  /** Already consent-filtered, redacted and bounded by agentExcerpt. */
  excerpt?: string;
  /** A finished task's final reply, redacted and bounded by agentAnswer; a trailing `…` marks it shortened. */
  answer?: string;
  questions?: Question[];
  links?: Links; privateChat?: boolean;
  /** False when a Reply cannot reach the task, so the notice must not invite one. */
  replyable?: boolean;
}

export interface ChatPresentation {
 label: string; maxText: number; buttonTextLimit: number;
 formatText(text: string, max?: number, username?: string): string;
 command(name: string, username?: string): string;
 isGroup(chatId: string): boolean;
 discoveryLink(username: string, code: string): string;
 taskReply(task: TaskReply): string;
 sourceOutcome(source: { state: string; policyReason?: string }): string;
}
