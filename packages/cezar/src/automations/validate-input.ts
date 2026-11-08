import { z } from 'zod';
import {
  trackerTriggerSchema,
  automationScheduleSchema,
  automationSchedulesSchema,
  automationScheduleIssue,
  localTimeZone,
  nextOccurrence,
  scheduleLabel,
  schedulesOf,
  type AutomationSchedule,
} from '@open-mercato/cezar-contract';
import { automationEventSchema, automationFiltersSchema, automationTaskSchema } from './types.ts';
import { validateAutomationPrompt } from './task-template.ts';

/**
 * The checks `POST /automations` runs, shared with the import engine (spec
 * 2026-11-04-automations-and-config-export-import) so an imported row is refused for exactly the
 * reasons a hand-created one would be.
 */
export const automationEditableSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().optional(),
    /** Omitted on create = `github`; omitted on update = the stored kind (spec 2026-09-14). */
    kind: z.enum(['github', 'schedule', 'tracker']).optional(),
    events: z.array(automationEventSchema).min(1).max(7).optional(),
    intervalSeconds: z.number().int().min(60).max(86_400).optional(),
    filters: automationFiltersSchema.optional(),
    trackerTrigger: trackerTriggerSchema.optional(),
    schedule: automationScheduleSchema.optional(),
    schedules: automationSchedulesSchema.optional(),
    task: automationTaskSchema,
  })
  .strict();
export type AutomationEditableBody = z.infer<typeof automationEditableSchema>;
export type AutomationKind = 'github' | 'schedule' | 'tracker';

/**
 * The kind rules the storage schema also enforces, answered as a 400 message rather than a zod
 * issue path (spec 2026-09-14 § Data Model): a poll needs its three keys; a schedule needs its
 * schedule and carries no GitHub filter.
 */
export function automationKindIssue(body: AutomationEditableBody, kind: AutomationKind): string | null {
  const timingIssue = automationScheduleIssue(body, kind);
  if (timingIssue) return timingIssue;
  // Tracker automations have no create/edit route yet (2026-09-19): hand-authored into
  // `automations.json` only. Refuse explicitly rather than misapplying the GitHub filter rules
  // below to one that reaches this far (e.g. a PUT that omits `kind` on an existing tracker row).
  if (kind === 'tracker') return body.trackerTrigger ? null : 'Choose an event to finish configuring this automation';
  if (kind === 'schedule') {
    if (body.events || body.filters || body.intervalSeconds !== undefined || body.trackerTrigger) return 'a scheduled automation has no GitHub filter';
    return null;
  }
  if (!body.events?.length) return 'a GitHub automation needs at least one event';
  if (body.intervalSeconds === undefined) return 'a GitHub automation needs a poll interval';
  if (!body.filters) return 'a GitHub automation needs its bounded filter';
  if (body.schedule) return 'a GitHub automation has no schedule';
  return null;
}

/**
 * A one-time schedule can only be ENABLED while its instant is still ahead (#771): enabling one
 * that has passed would arm nothing and sit "enabled" forever. Saved paused, it is a draft and is
 * accepted; Run now still works on it.
 */
export function oncePassedIssue(schedule: AutomationSchedule | undefined, enabled: boolean, now = Date.now()): string | null {
  if (!enabled || schedule?.type !== 'once') return null;
  if (nextOccurrence(schedule, now, localTimeZone()) !== null) return null;
  return `the one-time schedule (${scheduleLabel(schedule)}, ${localTimeZone()}) is not in the future; pick a later time`;
}

/** The project-bound checks, injected because they read the tracker driver and agent accounts. */
export interface AutomationInputChecks {
  trackerTriggerIssue(trigger: AutomationEditableBody['trackerTrigger']): Promise<string | null>;
  accountIssue(task: AutomationEditableBody['task']): Promise<string | null>;
}

/** Every create-route check in order; the first refusal, or null. */
export async function automationInputIssue(
  body: AutomationEditableBody,
  kind: AutomationKind,
  enable: boolean,
  checks: AutomationInputChecks,
): Promise<string | null> {
  const kindIssue = automationKindIssue(body, kind);
  if (kindIssue) return kindIssue;
  if (kind === 'tracker') {
    const issue = await checks.trackerTriggerIssue(body.trackerTrigger);
    if (issue) return issue;
  }
  const passedIssue = oncePassedIssue(schedulesOf(body)[0], enable);
  if (passedIssue) return passedIssue;
  const promptIssue = validateAutomationPrompt(body.task.prompt, kind);
  if (promptIssue) return promptIssue;
  return checks.accountIssue(body.task);
}
