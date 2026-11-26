import { z } from 'zod';

/**
 * The attention list (spec `.ai/specs/2026-11-20-phone-notifications-inbox.md`, variant D): everything
 * on this computer that waits on the user. Now's Needs you, the Now tab's badge and the phone's icon
 * badge are filters of it, so no count includes something no list shows.
 */

export const attentionKindSchema = z.enum(['question', 'approval', 'task', 'review', 'failed', 'message']);
export type AttentionKind = z.infer<typeof attentionKindSchema>;
export const ATTENTION_KINDS = attentionKindSchema.options;

/** Why an item probably no longer needs the user. */
export const attentionSettledReasonSchema = z.enum(['pr-merged', 'pr-closed', 'work-ended', 'overtaken', 'quiet']);
export type AttentionSettledReason = z.infer<typeof attentionSettledReasonSchema>;
export const attentionSettledSchema = z.object({
  why: attentionSettledReasonSchema,
  /** One line: "PR #2428 merged", "Quiet for 3 days". */
  detail: z.string().max(300),
});
export type AttentionSettled = z.infer<typeof attentionSettledSchema>;

export const attentionItemSchema = z.object({
  /** Stable per item: a re-raised wait gets a new key. */
  key: z.string(),
  kind: attentionKindSchema,
  title: z.string(),
  detail: z.string().optional(),
  since: z.string(),
  /** In the Now count, unless `settled`. False for failed tasks and for managers whose Notify is off. */
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
  /** Probably no longer needs the user (spec 2026-11-23-needs-you-triage): listed apart, never counted. */
  settled: attentionSettledSchema.optional(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

/** The user's own word on an item: `dismiss` hides it (until `until`, a snooze), `keep` overrides `settled`.
 *  Keyed by item key, so a re-raised wait (a new key) shows again. */
export const attentionOverrideModeSchema = z.enum(['dismiss', 'keep']);
export const attentionOverrideSchema = z.object({
  key: z.string().min(1).max(400),
  mode: attentionOverrideModeSchema,
  at: z.string(),
  until: z.string().optional(),
  /** The task a dismissal is about. It also covers that run's items that began before it (a closed
   *  question's wait), so the row the user dismissed never comes back under another key. */
  projectId: z.string().optional(),
  runId: z.string().optional(),
});
export type AttentionOverride = z.infer<typeof attentionOverrideSchema>;

/** `POST /workspace/attention/overrides`. */
export const attentionOverrideInputSchema = z.strictObject({
  key: z.string().min(1).max(400),
  mode: attentionOverrideModeSchema,
  /** A snooze's end; absent dismisses until the item changes. */
  until: z.string().datetime({ offset: true }).optional(),
  /** The item's task, when it has one. */
  projectId: z.string().min(1).max(300).optional(),
  runId: z.string().min(1).max(300).optional(),
});
export type AttentionOverrideInput = z.infer<typeof attentionOverrideInputSchema>;

/** `POST /workspace/attention/overrides/clear`: undo, or "Still needs me" on a dismissed item. */
export const attentionOverrideClearInputSchema = z.strictObject({ key: z.string().min(1).max(400) });

export const attentionOverridesResponseSchema = z.object({ overrides: z.array(attentionOverrideSchema) });
export type AttentionOverridesResponse = z.infer<typeof attentionOverridesResponseSchema>;

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
  /** Active overrides; Now hides its own task rows by them too. Dismissed items are already left out of `items`. */
  overrides: z.array(attentionOverrideSchema),
  /** The Questions page's Older days (`0` = off): past it an item is quiet, past half it sorts below fresh ones. */
  olderAfterDays: z.number().int().min(0),
});
export type AttentionResponse = z.infer<typeof attentionResponseSchema>;

const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const knownTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
/** In the phone's own time zone, sent with each `PUT`: the computer's clock is wrong for a travelling phone.
 *  `from` after `to` spans midnight; equal means off. */
export const quietHoursSchema = z.object({
  from: clockTimeSchema,
  to: clockTimeSchema,
  timeZone: z.string().min(1).max(64).refine(knownTimeZone, 'unknown time zone'),
}).strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** The push kinds a phone's app understands. Released apps know only `attention`. */
export const pushKindSchema = z.enum(['attention', 'count']);
export type PushKind = z.infer<typeof pushKindSchema>;

/**
 * `GET`/`PUT /workspace/phone/push/prefs`: one phone's notification settings, kept on the computer
 * because the relay never learns a kind (spec 2026-11-20-phone-notifications-inbox).
 */
export const phonePushPrefsSchema = z.object({
  /** Kinds that raise a push. */
  push: z.array(attentionKindSchema),
  /** Kinds counted on the app icon. */
  icon: z.array(attentionKindSchema),
  quiet: quietHoursSchema.optional(),
  /** The push kinds the phone's app understands; cezar sends `count` only to one that declared it. */
  understands: z.array(pushKindSchema),
}).strict();
export type PhonePushPrefs = z.infer<typeof phonePushPrefsSchema>;

/** `PUT /workspace/phones/:deviceId/prefs`: the computer edits the settings, never what the app understands. */
export const phonePushSettingsSchema = phonePushPrefsSchema.omit({ understands: true });
export type PhonePushSettings = z.infer<typeof phonePushSettingsSchema>;

/** Owner decision 2026-11-20: everything pushes; failed tasks do not count on the icon. */
export const DEFAULT_PHONE_PUSH_PREFS: PhonePushPrefs = {
  push: [...ATTENTION_KINDS],
  icon: ATTENTION_KINDS.filter((kind) => kind !== 'failed'),
  understands: ['attention'],
};
