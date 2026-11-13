import type { ChatSourceProvenance } from '@open-mercato/cezar-contract';
import type { RunRecord } from './store.ts';

/** No chat, user, bot or message identifier. */
export type PublicChatSource = ChatSourceProvenance;
export type PublicRun = Omit<RunRecord, 'chatSource'> & { chatSource?: PublicChatSource };

/** Every run that leaves the process (routes, SSE frames) goes through here (spec 2026-10-29). */
export function publicRun(run: RunRecord): PublicRun {
  const { chatSource, ...rest } = run;
  if (!chatSource) return rest;
  const { provider, id, projectId, receiverId, requestId, runId, createdAt } = chatSource;
  return { ...rest, chatSource: { provider, id, projectId, receiverId, requestId, ...(runId ? { runId } : {}), createdAt } };
}
