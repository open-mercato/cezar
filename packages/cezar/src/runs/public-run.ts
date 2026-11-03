import type { TelegramSourceProvenance } from '@open-mercato/cezar-contract';
import type { RunRecord } from './store.ts';

/** No chat, user, bot or message identifier. */
export type PublicTelegramSource = TelegramSourceProvenance;
export type PublicRun = Omit<RunRecord, 'telegramSource'> & { telegramSource?: PublicTelegramSource };

/** Every run that leaves the process (routes, SSE frames) goes through here (spec 2026-10-29). */
export function publicRun(run: RunRecord): PublicRun {
  const { telegramSource, ...rest } = run;
  if (!telegramSource) return rest;
  const { id, projectId, receiverId, requestId, runId, createdAt } = telegramSource;
  return { ...rest, telegramSource: { id, projectId, receiverId, requestId, runId, createdAt } };
}
