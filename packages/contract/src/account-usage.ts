import { z } from 'zod';

import { agentAccountRouteId } from './agent-profiles.ts';
import { runLiveUsageSchema } from './runs.ts';

/** One agent account's last observed plan windows for the cockpit sidebar (#1625 extension). */
export const accountUsageEntrySchema = z.object({
  id: z.string(),
  provider: z.enum(['claude', 'codex']),
  label: z.string(),
  isDefault: z.boolean(),
  routeId: z.string(),
  usage: runLiveUsageSchema,
});
export type AccountUsageEntry = z.infer<typeof accountUsageEntrySchema>;

/** `GET /api/v1/workspace/account-usage` — workspace-level, single-mount. */
export const accountUsageResponseSchema = z.object({
  accounts: z.array(accountUsageEntrySchema),
});
export type AccountUsageResponse = z.infer<typeof accountUsageResponseSchema>;

export function accountUsageRouteId(
  profile: Pick<AccountUsageEntry, 'id' | 'provider' | 'isDefault'>,
): string {
  return agentAccountRouteId(profile);
}