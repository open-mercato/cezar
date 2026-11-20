import { z } from 'zod';

/**
 * The attention list (spec `.ai/specs/2026-11-20-phone-notifications-inbox.md`, variant D): everything
 * on this computer that waits on the user. Now's Needs you, the Now tab's badge and the phone's icon
 * badge are filters of it, so no count includes something no list shows.
 */

export const attentionKindSchema = z.enum(['question', 'approval', 'task', 'review', 'failed', 'message']);
export type AttentionKind = z.infer<typeof attentionKindSchema>;
export const ATTENTION_KINDS = attentionKindSchema.options;

export const attentionItemSchema = z.object({
  /** Stable per item: a re-raised wait gets a new key. */
  key: z.string(),
  kind: attentionKindSchema,
  title: z.string(),
  detail: z.string().optional(),
  since: z.string(),
  /** In the Now count. False for failed tasks and for managers whose Notify is off. */
  counted: z.boolean(),
  projectId: z.string().optional(),
  runId: z.string().optional(),
  managerId: z.string().optional(),
  managerName: z.string().optional(),
  /** `question`: the Questions inbox key, for answer and dismiss. */
  questionKey: z.string().optional(),
  /** `question`: one single-select question's choices, answerable in place. */
  options: z.array(z.string()).optional(),
  /** `question`: the header an answer is prefixed with ("Header: Label"). */
  header: z.string().optional(),
  /** `approval`: the action message id, for the decision route. */
  actionId: z.string().optional(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const attentionCountsSchema = z.object({
  /** Counted items: the Now tab's badge. */
  total: z.number().int().min(0),
  question: z.number().int().min(0),
  approval: z.number().int().min(0),
  task: z.number().int().min(0),
  review: z.number().int().min(0),
  failed: z.number().int().min(0),
  message: z.number().int().min(0),
});
export type AttentionCounts = z.infer<typeof attentionCountsSchema>;

/** `GET /workspace/attention`. */
export const attentionResponseSchema = z.object({
  items: z.array(attentionItemSchema),
  counts: attentionCountsSchema,
  /** A digest of the item keys: changes whenever the list does. */
  revision: z.string(),
});
export type AttentionResponse = z.infer<typeof attentionResponseSchema>;

const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** In the computer's local time. `start` after `end` spans midnight; equal means off. */
export const quietHoursSchema = z.object({ start: clockTimeSchema, end: clockTimeSchema }).strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** One phone's notification settings, kept on the computer: the relay never learns a kind. */
export const phoneNotificationPrefsSchema = z.object({
  /** Kinds that raise a push. */
  push: z.array(attentionKindSchema),
  /** Kinds counted on the icon badge. */
  badge: z.array(attentionKindSchema),
  quietHours: quietHoursSchema.nullable(),
}).strict();
export type PhoneNotificationPrefs = z.infer<typeof phoneNotificationPrefsSchema>;

/** Owner decision 2026-11-20: everything pushes; failed tasks do not count on the icon. */
export const DEFAULT_PHONE_NOTIFICATION_PREFS: PhoneNotificationPrefs = {
  push: [...ATTENTION_KINDS],
  badge: ATTENTION_KINDS.filter((kind) => kind !== 'failed'),
  quietHours: null,
};
