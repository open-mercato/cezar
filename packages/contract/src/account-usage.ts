import { z } from 'zod';

/**
 * Per-account subscription usage an agent may ask for (`cez usage --live`, issue #1745).
 * Numbers only: no token, credential, email or raw provider message ever appears here.
 */
export const accountUsageStatusSchema = z.enum([
  'ok',
  /** The account's "Allow agents to check this account's usage" switch is off. Never queried. */
  'not-allowed',
  /** The agent has no usage source cezar can read. */
  'not-supported',
  /** The stored login is expired or missing; the user must run the agent once on that account. */
  'login-expired',
  /** The provider refused the request (HTTP 401/403). */
  'forbidden',
  /** The provider answered 429. Retry at most once, later. */
  'rate-limited',
  'unreachable',
  /** No answer and no known reading (timeout, saturated probe, nothing recorded yet). */
  'unavailable',
]);
export type AccountUsageStatus = z.infer<typeof accountUsageStatusSchema>;

export const accountUsageWindowSchema = z.object({
  kind: z.enum(['five-hour', 'weekly', 'other']),
  usedPercent: z.number().finite().nonnegative().nullable(),
  /** ISO time the window resets, when known. */
  resetsAt: z.string().nullable(),
});
export type AccountUsageWindow = z.infer<typeof accountUsageWindowSchema>;

export const accountUsageResultSchema = z.object({
  /** `claude:default`, `codex:work` — what `--account` takes. */
  key: z.string(),
  provider: z.string(),
  accountId: z.string(),
  label: z.string(),
  status: accountUsageStatusSchema,
  /** Fixed, credential-free sentence for a non-ok status. */
  message: z.string().optional(),
  /** `probe` = asked the provider now; `ledger` = last reading cezar recorded from a session. */
  source: z.enum(['probe', 'ledger']).optional(),
  observedAt: z.string().optional(),
  windows: z.array(accountUsageWindowSchema),
});
export type AccountUsageResult = z.infer<typeof accountUsageResultSchema>;

export const accountUsageReportSchema = z.object({
  generatedAt: z.string(),
  accounts: z.array(accountUsageResultSchema),
});
export type AccountUsageReport = z.infer<typeof accountUsageReportSchema>;

export const accountUsageQuerySchema = z.object({ account: z.string().max(300).optional() });
export type AccountUsageQuery = z.infer<typeof accountUsageQuerySchema>;

/** `provider:accountId` → allowed. Absent = off. */
export const accountUsageSwitchesSchema = z.object({ accounts: z.record(z.string(), z.boolean()) });
export type AccountUsageSwitches = z.infer<typeof accountUsageSwitchesSchema>;

export const accountUsageSwitchUpdateSchema = z.object({
  account: z.string().min(1).max(300).regex(/^[a-z0-9-]+:[a-z0-9][a-z0-9-]{0,63}$/),
  allowed: z.boolean(),
});
export type AccountUsageSwitchUpdate = z.infer<typeof accountUsageSwitchUpdateSchema>;
