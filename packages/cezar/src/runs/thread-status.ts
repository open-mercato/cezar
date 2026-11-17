import { statSync } from 'node:fs';
import { threadStatusSchema } from '@open-mercato/cezar-contract';
import { handoffPath, readHandoff } from '../handoff.ts';
import type { RunRecord } from './store.ts';

export function savedThreadStatus(dataDir: string, run: RunRecord) {
  let contentUpdatedAt: string | null = null;
  try { contentUpdatedAt = statSync(handoffPath(dataDir, run.id)).mtime.toISOString(); } catch { /* no saved notes */ }
  return threadStatusSchema.parse({
    status: run.status, handoff: readHandoff(dataDir, run.id), contentUpdatedAt,
    continuations: run.threadHygiene?.continuations ?? null,
    historyKnown: run.threadHygiene?.historyKnown ?? false,
  });
}
