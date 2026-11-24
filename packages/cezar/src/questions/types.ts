import type { QuestionClosed, QuestionItem } from '@open-mercato/cezar-contract';

/**
 * One source of questions for the Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`):
 * the manager engine (`managers/questions.ts`) or every project's runs (`runs/questions.ts`). The
 * aggregator (`questions/inbox.ts`) merges them, computes Older, links relayed pairs and counts.
 * A provider never knows about the other one; linked-pair propagation is the aggregator's job.
 */
export interface QuestionProvider {
  /** Open questions plus those closed in the last `QUESTIONS_CLOSED_WINDOW_DAYS`. `older` is always
   *  false here; `linked` is left unset (the aggregator fills both). */
  list(): Promise<QuestionItem[]>;
  /** Owns `key` (its `m:`/`r:` prefix and source). */
  owns(key: string): boolean;
  /** Deliver an answer, as the card itself would. Closes the item as `answered`. `reactivate`: the
   *  user confirmed reactivating an inactive manager first (spec 2026-11-19-manager-deactivate). */
  answer(key: string, text: string, options?: AnswerOptions): Promise<QuestionResult>;
  /** Close as `dismissed` and tell the agent it was skipped (delivery rules per source, spec §dismiss). */
  dismiss(key: string): Promise<QuestionResult>;
  /** Close from outside without telling the agent anything beyond `closed` itself: the aggregator
   *  uses it when the linked copy closed. A manager copy closed as `answered` on its task queues a
   *  note for the manager's next turn. No-op (`ok`) when already closed. */
  close(key: string, closed: QuestionClosed): Promise<QuestionResult>;
  /** Fired after any change to this provider's questions: opened, closed, flagged. `closedItem` is
   *  set when the change closed a question, so the aggregator can close its linked copy. */
  onChange(listener: (change: QuestionChange) => void): () => void;
}

export interface AnswerOptions {
  reactivate?: boolean;
}

export type QuestionResult =
  | { ok: true; item: QuestionItem }
  | { ok: false; status: 404 | 409; error: string };

export interface QuestionChange {
  closedItem?: QuestionItem;
}
