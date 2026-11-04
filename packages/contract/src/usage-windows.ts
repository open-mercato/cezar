import { z } from 'zod';

/** Metadata only: no raw provider messages, credentials or prompts. Times are epoch ms. */
export const usageWindowSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(['five-hour', 'weekly', 'primary', 'secondary', 'other']),
  limitId: z.string().max(128).optional(),
  applicability: z.enum(['all', 'models', 'unknown']),
  models: z.array(z.string().min(1).max(128)).max(32).default([]),
  resetsAt: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
  durationMinutes: z.number().positive().finite().nullable(),
  usedPercent: z.number().nonnegative().finite().nullable(),
  status: z.enum(['allowed', 'blocked', 'unknown']),
  observedAt: z.number().int().nonnegative(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageWindowsObservationSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  source: z.enum(['claude-stream', 'codex-notification', 'codex-read']),
  observedAt: z.number().int().nonnegative(),
  windows: z.array(usageWindowSchema).max(128),
});
export type UsageWindowsObservation = z.infer<typeof usageWindowsObservationSchema>;

export const usageAccountBindingSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  accountId: z.string().min(1).max(256),
  profilePath: z.string().min(1).max(4096),
  /** SHA-256 of provider identity metadata, never an auth token. */
  identity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type UsageAccountBinding = z.infer<typeof usageAccountBindingSchema>;

export const usageWindowsSnapshotSchema = usageWindowsObservationSchema.extend({
  binding: usageAccountBindingSchema,
}).refine((s) => s.provider === s.binding.provider, 'Provider must match account binding');
export type UsageWindowsSnapshot = z.infer<typeof usageWindowsSnapshotSchema>;
