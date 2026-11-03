import { z } from 'zod';
import { trackerAssociationSchema, webhookAttentionRequestSchema, webhookCompletionReasonSchema, webhookTaskEventTypeSchema } from '@open-mercato/cezar-contract';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const time = z.iso.datetime();
export const sourceSnapshotSchema = z.strictObject({
  id, status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']), archived: z.boolean(),
  continuation: z.number().int().nonnegative(), title: z.string().max(512).optional(), titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  attentionRequest: webhookAttentionRequestSchema.optional(), completionReason: webhookCompletionReasonSchema.optional(),
  autoResumeAt: time.optional(), finishedAt: time.optional(), startedAt: time.optional(),
  parentTaskId: id.optional(), rootTaskId: id.optional(), error: z.string().max(4000).optional(),
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), costUsd: z.number().finite().nonnegative().optional(),
  automationTracker: z.strictObject({ provider: z.enum(['jira', 'linear']), association: trackerAssociationSchema.optional(), key: z.string().max(128), url: z.string().max(2048) }).optional(),
  automationUrl: z.string().max(2048).optional(),
  pullRequestUrl: z.string().max(2048).optional(), referencedPullRequestUrl: z.string().max(2048).optional(), referencedIssueUrl: z.string().max(2048).optional(),
});
export const webhookSourceSchema = z.strictObject({
  trackerIssueUrl: z.httpUrl().max(2048).optional(),
  cockpitUrl: z.httpUrl().max(2048).optional(),
  version: z.literal(1), truncated: z.literal(true).optional(), id: z.string().regex(/^evt_[0-9a-f-]{36}$/), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  installationId: id, projectId: id, previousStatus: sourceSnapshotSchema.shape.status, episodeId: id, type: webhookTaskEventTypeSchema, occurredAt: time, mode: z.enum(['local', 'hosted']), snapshot: sourceSnapshotSchema,
});
export type WebhookSource = z.infer<typeof webhookSourceSchema>;
