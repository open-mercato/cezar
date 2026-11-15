import { z } from 'zod';
import { trackerItemSchema } from './tracker.ts';

/** Explicitly reviewed replacement for legacy direct vendor access. Absent means migration required. */
export const trackerAccessSchema = z.object({
  version: z.literal(1),
  writes: z.array(z.enum(['comment', 'transition'])).max(2),
});
export const trackerContextSchema = z.object({
  issueId: z.string().min(1),
  item: trackerItemSchema,
  statusId: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  comments: z.array(z.object({ id: z.string(), author: z.string(), body: z.string(), createdAt: z.string() })),
  limitations: z.array(z.string()),
  transitions: z.array(z.object({ id: z.string(), name: z.string(), statusId: z.string() })),
});
export type TrackerContext = z.infer<typeof trackerContextSchema>;
export const trackerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), body: z.string().trim().min(1).max(30000) }).strict(),
  z.object({ kind: z.literal('transition'), transitionId: z.string().min(1).max(256), expectedStatusId: z.string().min(1).max(256) }).strict(),
]);
export type TrackerAction = z.infer<typeof trackerActionSchema>;
export const trackerOperationInputSchema = z.object({ operationId: z.uuid(), action: trackerActionSchema }).strict();
export type TrackerOperationInput = z.infer<typeof trackerOperationInputSchema>;
export const trackerOperationResultSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(['completed', 'unknown', 'rejected']),
  message: z.string(),
});
export type TrackerOperationResult = z.infer<typeof trackerOperationResultSchema>;
