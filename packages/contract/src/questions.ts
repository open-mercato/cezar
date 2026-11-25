import { z } from 'zod';

/**
 * The Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`): every open question from
 * managers (`CEZ:ASK` decision cards) and tasks (ask cards) in one list, with the reason each one
 * closed. Managers and tasks both describe their questions with these shapes.
 */

/** What a card says it is about. A declared PR/issue/task that reaches a final state expires the card;
 *  `{ task, ask }` names a task's own question, so a manager's relayed copy and the original are one. */
export const questionAboutRefSchema = z.union([
  z.strictObject({ pr: z.number().int().positive() }),
  z.strictObject({ issue: z.number().int().positive() }),
  z.strictObject({
    /** `<projectId>/<runId>`. */
    task: z.string().min(3).max(300),
    /** The task's question: its card `id`, else its `requestId`. */
    ask: z.string().min(1).max(200).optional(),
  }),
]);
export type QuestionAboutRef = z.infer<typeof questionAboutRefSchema>;
export const QUESTION_ABOUT_MAX = 5;
export const questionAboutSchema = z.array(questionAboutRefSchema).min(1).max(QUESTION_ABOUT_MAX);
export type QuestionAbout = z.infer<typeof questionAboutSchema>;

/** A card's stable name: asking again with it replaces the older card, `CEZ:ASK-CLOSE <id>` withdraws it. */
export const questionCardIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const questionCloseReasonSchema = z.enum(['answered', 'dismissed', 'replaced', 'retracted', 'expired', 'ended']);
export type QuestionCloseReason = z.infer<typeof questionCloseReasonSchema>;

export const questionClosedSchema = z.object({
  reason: questionCloseReasonSchema,
  at: z.string(),
  /** One line for the Closed row: the agent's reason, "PR #2891 merged", how the task ended. */
  detail: z.string().max(300).optional(),
  /** The newer card's id in the same chat or run (`replaced`). */
  replacedBy: z.string().optional(),
  /** The answer, when `answered`. */
  answer: z.string().max(4000).optional(),
  /** Answered on the linked copy: `task:<projectId>/<runId>` or `manager:<managerId>`. */
  answeredIn: z.string().optional(),
});
export type QuestionClosed = z.infer<typeof questionClosedSchema>;

/** Suspected out of date. The card stays open and still counts; the agent is asked to confirm. */
export const questionStaleReasonSchema = z.enum(['replied-in-chat', 'task-moved-on', 'new-commits', 'manager-acted', 'mentioned-work-ended', 'partly-reasked']);
export type QuestionStaleReason = z.infer<typeof questionStaleReasonSchema>;
export const questionStaleSchema = z.object({
  why: questionStaleReasonSchema,
  /** The note's text, e.g. "you replied 4m after it was asked". */
  detail: z.string().max(300),
  since: z.string(),
});
export type QuestionStale = z.infer<typeof questionStaleSchema>;

export const questionOptionSchema = z.object({ label: z.string(), description: z.string().optional() });
export const questionQuestionSchema = z.object({
  id: z.string().optional(),
  header: z.string(),
  question: z.string(),
  multiSelect: z.boolean().optional(),
  options: z.array(questionOptionSchema),
});
export type QuestionQuestion = z.infer<typeof questionQuestionSchema>;

export const questionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manager'), managerId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('task'), projectId: z.string(), runId: z.string(), title: z.string(), status: z.string() }),
]);
export type QuestionSource = z.infer<typeof questionSourceSchema>;

export const questionTaskRefSchema = z.object({ projectId: z.string(), runId: z.string() });

export const questionItemSchema = z.object({
  /** `m:<managerId>:<messageId>` or `r:<projectId>:<runId>:<requestId>` (`questionKey`). */
  key: z.string(),
  source: questionSourceSchema,
  cardId: z.string().optional(),
  askedAt: z.string(),
  questions: z.array(questionQuestionSchema),
  about: questionAboutSchema.optional(),
  /** Tasks the card names (`[[task:…]]`), for the Source task block. */
  sourceTasks: z.array(questionTaskRefSchema).optional(),
  stale: questionStaleSchema.optional(),
  /** Open longer than the Older threshold: still answerable, not counted. */
  older: z.boolean(),
  /** The other copy of the same question (a manager relaying a task's question). */
  linked: z.object({ key: z.string(), source: questionSourceSchema }).optional(),
  closed: questionClosedSchema.optional(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;

export const questionCountsSchema = z.object({
  /** Open, not Older. Flagged (stale) questions count. A linked pair counts once. */
  live: z.number().int().min(0),
  older: z.number().int().min(0),
});
export type QuestionCounts = z.infer<typeof questionCountsSchema>;

/** A `questions` topic frame: the counts, plus a digest of the open list that changes even when
 *  they do not (one card replaced by another). Optional: an older server sends counts alone. */
export const questionsTopicFrameSchema = questionCountsSchema.extend({
  revision: z.string().max(64).optional(),
});
export type QuestionsTopicFrame = z.infer<typeof questionsTopicFrameSchema>;

export const questionsResponseSchema = z.object({
  open: z.array(questionItemSchema),
  /** Closed in the last 7 days, newest first, at most 50. */
  closed: z.array(questionItemSchema),
  counts: questionCountsSchema,
  /** Days before an open question moves to Older; 0 = off. */
  olderAfterDays: z.number().int().min(0),
});
export type QuestionsResponse = z.infer<typeof questionsResponseSchema>;

export const questionKeyParamSchema = z.object({ key: z.string().min(3).max(400) });
export const answerQuestionInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(100_000),
  /** A manager's card whose manager is inactive: the user confirmed reactivating it (spec 2026-11-19-manager-deactivate). */
  reactivate: z.literal(true).optional(),
});
export type AnswerQuestionInput = z.infer<typeof answerQuestionInputSchema>;
export const questionMutationResponseSchema = z.object({ ok: z.literal(true), item: questionItemSchema });
export type QuestionMutationResponse = z.infer<typeof questionMutationResponseSchema>;

/** The run record's own copy of a task's question (`RunRecord.asks`). Bodies are bounded like the card. */
export const taskAskRecordSchema = z.object({
  requestId: z.string(),
  askedAt: z.string(),
  cardId: z.string().optional(),
  about: questionAboutSchema.optional(),
  questions: z.array(questionQuestionSchema).max(20),
  closed: questionClosedSchema.optional(),
  stale: questionStaleSchema.optional(),
});
export type TaskAskRecord = z.infer<typeof taskAskRecordSchema>;
export const TASK_ASKS_MAX = 10;

export type QuestionKey =
  | { kind: 'manager'; managerId: string; messageId: string }
  | { kind: 'task'; projectId: string; runId: string; requestId: string };

export function questionKey(key: QuestionKey): string {
  return key.kind === 'manager' ? `m:${key.managerId}:${key.messageId}` : `r:${key.projectId}:${key.runId}:${key.requestId}`;
}

export function parseQuestionKey(key: string): QuestionKey | undefined {
  const parts = key.split(':');
  if (parts[0] === 'm' && parts.length === 3 && parts[1] && parts[2]) return { kind: 'manager', managerId: parts[1], messageId: parts[2] };
  if (parts[0] === 'r' && parts.length === 4 && parts[1] && parts[2] && parts[3]) return { kind: 'task', projectId: parts[1], runId: parts[2], requestId: parts[3] };
  return undefined;
}

export const QUESTIONS_OLDER_DEFAULT_DAYS = 7;
export const QUESTIONS_CLOSED_WINDOW_DAYS = 7;
export const QUESTIONS_CLOSED_MAX = 50;

/** The two parts of a card the replace rule reads; a manager ask and a task's ask record both have them. */
export interface QuestionCardShape {
  id?: string | undefined;
  questions: ReadonlyArray<{ header: string }>;
}

const questionHeaderKey = (header: string): string => header.trim().toLowerCase().replace(/\s+/g, '-');

/**
 * Close rule "replaced" (spec 2026-11-17-questions-inbox): the same card `id`, or, for an older card
 * without one, ONE newer card re-asking every one of its headers. Partial overlap never replaces.
 */
export function questionCardReplaces(newer: QuestionCardShape, older: QuestionCardShape): boolean {
  if (newer.id !== undefined && older.id === newer.id) return true;
  if (older.id !== undefined || older.questions.length === 0) return false;
  const headers = new Set(newer.questions.map((question) => questionHeaderKey(question.header)));
  return older.questions.every((question) => headers.has(questionHeaderKey(question.header)));
}

/** Shares some of the older card's headers without replacing it: the older card is flagged `partly-reasked`. */
export function questionCardPartlyReasked(newer: QuestionCardShape, older: QuestionCardShape): boolean {
  if (questionCardReplaces(newer, older)) return false;
  const headers = new Set(newer.questions.map((question) => questionHeaderKey(question.header)));
  return older.questions.some((question) => headers.has(questionHeaderKey(question.header)));
}

/** The re-asked headers, for the flag's note. */
export function questionCardSharedHeaders(newer: QuestionCardShape, older: QuestionCardShape): string[] {
  const headers = new Set(newer.questions.map((question) => questionHeaderKey(question.header)));
  return older.questions.filter((question) => headers.has(questionHeaderKey(question.header))).map((question) => question.header);
}
