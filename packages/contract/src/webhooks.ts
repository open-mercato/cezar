import { z } from 'zod';

// Kept independent of runs.ts: run persistence also consumes the optional lifecycle fields.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
export const webhookTaskEventTypeSchema = z.enum([
  'task.attention_required', 'task.review_ready', 'task.finished', 'task.failed', 'task.cancelled',
]);
export const webhookEventTypeSchema = z.enum([...webhookTaskEventTypeSchema.options, 'webhook.test']);
export const webhookProfileSchema = z.enum(['minimal', 'standard']);
export const webhookReceiverStateSchema = z.enum(['inactive', 'active', 'paused', 'suspended', 'disabled']);
export const webhookCompletionReasonSchema = z.enum(['pr_opened', 'accepted', 'no_changes', 'completed', 'unknown']);
const taskStatus = z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']);
const question = z.strictObject({
  question: z.string().min(1).max(2000),
  options: z.array(z.strictObject({ label: z.string().min(1).max(120), description: z.string().max(500).optional() })).max(10).optional(),
});
export const webhookAttentionRequestSchema = z.strictObject({
  requestId: id, askedAt: timestamp, questions: z.array(question).min(1).max(20),
});
const links = z.strictObject({
  cockpit: z.httpUrl().max(2048).optional(),
  pullRequest: z.httpUrl().max(2048).optional(), issue: z.httpUrl().max(2048).optional(),
});
const envelope = {
  id: z.string().regex(/^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  schemaVersion: z.literal(1), occurredAt: timestamp,
};
const lifecycle = {
  ...envelope, sequence: revision,
  source: z.strictObject({ instanceId: id, projectId: id.refine(value => value !== 'default', 'Use the real project slug'), mode: z.enum(['local', 'hosted']) }),
  tree: z.strictObject({ rootTaskId: id, parentTaskId: id.optional() }).optional(),
  links: links.optional(), truncated: z.literal(true).optional(),
};
const task = { id, previousStatus: taskStatus, title: z.string().max(512).optional() };
const episode = { episodeId: id, since: timestamp };
const failure = { episodeId: id, failedAt: timestamp, stepId: id.optional(), category: z.string().max(80).optional(), message: z.string().max(4000).optional() };
export const webhookEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...lifecycle, type: z.literal('task.attention_required'), task: z.strictObject({ ...task, status: z.literal('waiting') }),
    data: z.strictObject({ ...episode, reason: z.enum(['question', 'turn_end']), requestId: id.optional(), questions: z.array(question).max(20).optional() }) }),
  z.strictObject({ ...lifecycle, type: z.literal('task.review_ready'), task: z.strictObject({ ...task, status: z.literal('review') }),
    data: z.strictObject({ ...episode, diff: z.strictObject({ files: count, additions: count, deletions: count }).optional(), checks: z.array(z.strictObject({ name: z.string().max(100), status: z.enum(['passed', 'failed', 'skipped']) })).max(20).optional() }) }),
  z.strictObject({ ...lifecycle, type: z.literal('task.finished'), task: z.strictObject({ ...task, status: z.literal('done') }),
    data: z.strictObject({ resolution: webhookCompletionReasonSchema, finishedAt: timestamp, startedAt: timestamp.optional(), usage: z.strictObject({ inputTokens: count.optional(), outputTokens: count.optional(), costUsd: z.number().nonnegative().finite().optional(), coverage: z.enum(['complete', 'partial']).optional() }).optional() }) }),
  z.strictObject({ ...lifecycle, type: z.literal('task.failed'), task: z.strictObject({ ...task, status: z.literal('failed') }),
    data: z.discriminatedUnion('disposition', [
      z.strictObject({ ...failure, disposition: z.literal('manual') }),
      z.strictObject({ ...failure, disposition: z.literal('scheduled'), autoResumeAt: timestamp }),
    ]) }),
  z.strictObject({ ...lifecycle, type: z.literal('task.cancelled'), task: z.strictObject({ ...task, status: z.literal('cancelled') }),
    data: z.strictObject({ at: timestamp, reason: z.enum(['user', 'parent', 'budget', 'shutdown', 'unknown']).optional() }) }),
  z.strictObject({ ...envelope, type: z.literal('webhook.test'), data: z.strictObject({ test: z.literal(true), format: z.literal('cezar.json.v1') }) }),
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
export type WebhookTaskEventType = z.infer<typeof webhookTaskEventTypeSchema>;
export type WebhookProfile = z.infer<typeof webhookProfileSchema>;
export type WebhookAttentionRequest = z.infer<typeof webhookAttentionRequestSchema>;
export type WebhookCompletionReason = z.infer<typeof webhookCompletionReasonSchema>;

// This is syntax validation only. DNS, normalized numeric IPs and self-port policy belong to transport.
const destination = z.url({ protocol: /^https?$/ }).max(2048).regex(/^https?:\/\/[^\s@#]+$/i, 'Use an HTTP(S) URL without credentials or fragments');
// Use Zod's WHATWG normalization to count ASCII/punycode host bytes without a DOM
// or Node dependency. Keep the persisted schema permissive so one legacy receiver
// cannot make the entire registry unreadable.
const normalizedDestination = z.url({ protocol: /^https?$/, normalize: true });
export function validWebhookDestinationHost(value: string): boolean {
  const parsed = normalizedDestination.safeParse(value);
  if (!parsed.success) return false;
  const authority = /^https?:\/\/([^/?#]+)/i.exec(parsed.data)?.[1];
  const host = authority?.replace(/:[0-9]+$/, '');
  return !!host && host.length <= 255;
}
export const webhookFormatSchema = z.enum(['cezar.json.v1', 'slack.v1', 'discord.v1']);
export type WebhookFormat = z.infer<typeof webhookFormatSchema>;
const discordHosts = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
function chatDestination(value: { format: WebhookFormat; url?: string; allowLocalNetwork: boolean }, ctx: z.RefinementCtx): void {
  const fail = (message: string, path = 'url') => ctx.addIssue({ code: 'custom', message, path: [path] });
  if (value.format !== 'cezar.json.v1' && value.allowLocalNetwork) fail('Chat destinations cannot use local networks', 'allowLocalNetwork');
  if (!value.url) return; // The registry validates again after restoring the private URL.
  // Syntax is already checked by z.url. Keep the shared contract Node/DOM-free.
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)(.*)$/i.exec(value.url);
  if (!parts) return;
  const authority = parts[1]!.toLowerCase();
  const host = authority.replace(/:[0-9]+$/, '');
  if (value.format === 'cezar.json.v1') {
    if (host === 'hooks.slack.com') fail('Choose Slack as the destination type');
    if (discordHosts.has(host)) fail('Choose Discord as the destination type');
    return;
  }
  // Raw authority preserves explicit :443, which URL normalization removes.
  const validPath = value.format === 'slack.v1'
    ? authority === 'hooks.slack.com' && /^\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9_-]+$/.test(parts[2]!)
    : discordHosts.has(authority) && /^\/api\/(?:v10\/)?webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,80}$/.test(parts[2]!);
  if (!/^https:\/\//i.test(value.url) || parts[3] || !validPath) {
    fail(value.format === 'slack.v1' ? 'Paste the full Slack Incoming Webhook URL, like https://hooks.slack.com/services/…' : 'Paste the full Discord webhook URL, like https://discord.com/api/webhooks/…');
  }
}
const settings = {
  format: webhookFormatSchema.default('cezar.json.v1'),
  name: z.string().trim().min(1).max(100), url: destination,
  profile: webhookProfileSchema.default('minimal'),
  preset: z.enum(['attention', 'all', 'custom']).default('attention'),
  events: z.array(webhookTaskEventTypeSchema).max(5).default([]),
  includeScheduledFailures: z.boolean().default(false),
  scope: z.enum(['main_and_questions', 'every_task']).default('main_and_questions'),
  graceSeconds: z.union([z.literal(0), z.literal(60), z.literal(180), z.literal(600)]).default(180),
  allowLocalNetwork: z.boolean().default(false),
};
export const webhookStoredSettingsSchema = z.strictObject(settings).refine(
  value => value.preset !== 'custom' || value.events.length > 0, { message: 'Select at least one event', path: ['events'] },
).refine(value => new Set(value.events).size === value.events.length, { message: 'Duplicate event', path: ['events'] });
const boundedDestination = destination.refine(validWebhookDestinationHost, 'Invalid destination host');
export const createWebhookSchema = webhookStoredSettingsSchema.safeExtend({ url: boundedDestination }).superRefine(chatDestination);
// Edits are full settings submissions (omit URL to preserve its private value); service compares fields so a rename preserves deliveryRevision.
export const updateWebhookSchema = z.strictObject({ ...settings, expectedRevision: revision, url: boundedDestination.optional() }).refine(
  value => value.preset !== 'custom' || value.events.length > 0, { message: 'Select at least one event', path: ['events'] },
).refine(value => new Set(value.events).size === value.events.length, { message: 'Duplicate event', path: ['events'] }).superRefine(chatDestination);
export const webhookRevisionSchema = z.strictObject({ expectedRevision: revision });
export const webhookActivationSchema = z.strictObject({ expectedRevision: revision, confirmed: z.literal(true) });
export const webhookRotationSchema = z.strictObject({ expectedRevision: revision, mode: z.enum(['graceful', 'revoke_now']) });
export const webhookOperationSchema = z.strictObject({ expectedRevision: revision, deliveryRevision: revision, operationId: id });
export const webhookReplaySchema = webhookOperationSchema.extend({ confirmed: z.literal(true) });
export const webhookNoticeAcknowledgementSchema = z.strictObject({ expectedChangeSequence: count });
// Mounted project routes add projectId; the family validates only its own parameters.
export const webhookReceiverParamsSchema = z.object({ id });
export const webhookDeliveryParamsSchema = z.object({ deliveryId: id });
const page = { limit: z.coerce.number().int().min(1).max(100).default(100), cursor: z.string().min(1).max(4096).optional() };
export const webhookHistoryQuerySchema = z.strictObject(page);
export const webhookDeliveriesQuerySchema = z.strictObject({ ...page, taskId: id.optional() });
export const webhookDeliveryStatusSchema = z.enum(['pending', 'in_flight', 'retrying', 'blocked_policy', 'delivered', 'failed', 'superseded', 'cancelled', 'dropped']);
export const webhookHealthSchema = z.strictObject({ status: z.enum(['disabled', 'ready', 'degraded', 'unavailable']), reason: z.string().max(500).optional(), saturation: z.strictObject({ pending: z.boolean(), retained: z.boolean(), control: z.boolean(), dropped: count }).optional() });
export const webhookReceiverSchema = z.strictObject({
  kind: z.literal('live'), id, name: settings.name, destination: z.string().max(300),
  format: webhookFormatSchema, state: webhookReceiverStateSchema, revision, deliveryRevision: revision,
  /** Present only while paused; `user` for a cockpit pause, `project_removal` when removing a project paused it. */
  pauseReason: z.enum(['user', 'project_removal']).optional(),
  profile: webhookProfileSchema, preset: settings.preset.removeDefault(), events: settings.events.removeDefault(),
  includeScheduledFailures: z.boolean(), scope: settings.scope.removeDefault(), graceSeconds: settings.graceSeconds.removeDefault(), allowLocalNetwork: z.boolean(),
  createdAt: timestamp, updatedAt: timestamp, pendingCount: count, inFlightCount: count,
  consecutiveFailures: count, nextProbeAt: timestamp.optional(), retiredKeyExpiresAt: timestamp.optional(),
  activationBlocked: z.boolean(), lastTest: z.enum(['none', 'success', 'transient_failure', 'permanent_failure']),
});
export const webhookHistoricalReceiverSchema = z.strictObject({ kind: z.literal('history'), id, name: z.string().max(100), deletedAt: timestamp });
export const webhookNoticeSchema = z.strictObject({ changeSequence: count, at: timestamp, action: z.string().max(80), receiverName: z.string().max(100).optional(), receiverId: id.optional(), destination: z.string().max(300).optional(), source: z.enum(['cockpit/api', 'system']).optional() });
export const webhookListSchema = z.strictObject({
  receivers: z.array(webhookReceiverSchema), webhookHealth: webhookHealthSchema, changeSequence: count,
  notice: webhookNoticeSchema.optional(), history: z.array(webhookHistoricalReceiverSchema).max(100), historyCount: count,
});
export const webhookSecretResponseSchema = z.strictObject({ receiver: webhookReceiverSchema, secret: z.string().max(128) });
export const webhookReceiverResponseSchema = z.strictObject({ receiver: webhookReceiverSchema });
export const webhookDeliveryOperationResponseSchema = z.strictObject({ deliveryId: id });
export const webhookOkSchema = z.strictObject({ ok: z.literal(true) });
export const webhookHistoryPageSchema = z.strictObject({ items: z.array(webhookHistoricalReceiverSchema).max(100), total: count, hasMore: z.boolean(), nextCursor: z.string().max(4096).optional() });
export const webhookDeliverySchema = z.strictObject({
  deliveryId: id, eventId: z.string().max(128), receiverId: id, deliveryRevision: revision,
  eventType: webhookEventTypeSchema, taskId: id.optional(), status: webhookDeliveryStatusSchema,
  createdAt: timestamp, expiresAt: timestamp, attempts: count, destination: z.string().max(300),
  nextAttemptAt: timestamp.optional(), completedAt: timestamp.optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  reason: z.string().max(500).optional(), response: z.string().max(4096).optional(),
  retryAllowed: z.boolean(), replayAllowed: z.boolean(),
  payloadAvailability: z.enum(['retained', 'expired', 'not_created', 'unknown']).optional(),
  payloadRetainedUntil: timestamp.optional(), historyRetainedUntil: timestamp.optional(),
  taskAvailability: z.enum(['available', 'deleted', 'unknown', 'not_applicable']).optional(),
  replayUnavailableReason: z.enum(['receiver_deleted', 'receiver_inactive', 'configuration_changed', 'task_unavailable', 'not_fresh', 'not_terminal', 'synthetic_test', 'payload_expired', 'payload_unavailable']).optional(),
});
export const webhookDeliveriesPageSchema = z.strictObject({
  receiver: z.discriminatedUnion('kind', [webhookReceiverSchema, webhookHistoricalReceiverSchema]),
  items: z.array(webhookDeliverySchema).max(100), total: count, hasMore: z.boolean(), nextCursor: z.string().max(4096).optional(), timezone: z.string().max(100),
});
export const webhookActivitySchema = z.strictObject({ id, at: timestamp, action: z.string().max(80), source: z.enum(['cockpit/api', 'system']), revision: revision.optional(), fields: z.array(z.string().max(80)).max(20), detail: z.string().max(500).optional() });
export const webhookActivityPageSchema = z.strictObject({
  receiver: z.discriminatedUnion('kind', [webhookReceiverSchema, webhookHistoricalReceiverSchema]),
  items: z.array(webhookActivitySchema).max(100), total: count, hasMore: z.boolean(), timezone: z.string().max(100),
});
export const webhookInvalidationSchema = z.strictObject({ type: z.enum(['change', 'resync']), changeSequence: count });
export type CreateWebhook = z.infer<typeof createWebhookSchema>;
export type UpdateWebhook = z.infer<typeof updateWebhookSchema>;
export type WebhookReceiver = z.infer<typeof webhookReceiverSchema>;
export type WebhookReceiverState = z.infer<typeof webhookReceiverStateSchema>;
export type WebhookHistoricalReceiver = z.infer<typeof webhookHistoricalReceiverSchema>;
export type WebhookList = z.infer<typeof webhookListSchema>;
export type WebhookHealth = z.infer<typeof webhookHealthSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;
export type WebhookActivity = z.infer<typeof webhookActivitySchema>;
export type WebhookDeliveriesPage = z.infer<typeof webhookDeliveriesPageSchema>;
export type WebhookActivityPage = z.infer<typeof webhookActivityPageSchema>;
export type WebhookHistoryPage = z.infer<typeof webhookHistoryPageSchema>;
export type WebhookInvalidation = z.infer<typeof webhookInvalidationSchema>;
export type WebhookOperation = z.infer<typeof webhookOperationSchema>;
