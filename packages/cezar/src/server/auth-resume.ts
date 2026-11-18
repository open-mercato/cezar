import type { ReconnectResumed } from '@open-mercato/cezar-contract';
import { onAccountReconnected, type AccountReconnected } from '../core/account-reconnected.ts';
import type { ProjectContext, ProjectContexts } from './project-context.ts';

export interface AuthResumeDeps {
  contexts: Pick<ProjectContexts, 'ids' | 'peek' | 'onContextBuilt'>;
  /** The project this server was started in: it never enters the lazy map. */
  boot?: { context: ProjectContext; projectId: () => Promise<string> };
  managers?: { resumeAuthFailed(provider: string, profileId: string): ReconnectResumed['managers'] };
}

/**
 * Restart what was blocked on an agent account once it is signed in again (spec
 * 2026-11-18-inline-account-reconnect § Resume): every run parked on it in each built project,
 * and every manager whose chat turn failed on it. A project built later resumes the runs parked
 * before a reconnect this process saw; after a restart nothing is remembered, and those stay
 * parked until the next sign-in or Check again. Returns the unsubscribe.
 */
export function registerAuthResume(deps: AuthResumeDeps): () => void {
  const reconnectedAt = new Map<string, { event: AccountReconnected; at: string }>();
  const resumeIn = (ctx: ProjectContext, event: AccountReconnected, parkedBefore?: string, projectId = ctx.id): ReconnectResumed['runs'] =>
    ctx.manager.resumeAuthParked(event.provider, event.profileId, parkedBefore)
      .map(({ runId, title }) => ({ projectId, runId, title }));

  const offReconnected = onAccountReconnected(async (event) => {
    reconnectedAt.set(`${event.provider}:${event.profileId}`, { event, at: new Date().toISOString() });
    const runs: ReconnectResumed['runs'] = [];
    if (deps.boot) runs.push(...resumeIn(deps.boot.context, event, undefined, await deps.boot.projectId().catch(() => deps.boot!.context.id)));
    for (const id of deps.contexts.ids()) {
      const ctx = deps.contexts.peek(id);
      if (ctx) runs.push(...resumeIn(ctx, event));
    }
    return { runs, managers: deps.managers?.resumeAuthFailed(event.provider, event.profileId) ?? [] };
  });
  const offBuilt = deps.contexts.onContextBuilt((ctx) => {
    for (const { event, at } of reconnectedAt.values()) resumeIn(ctx, event, at);
  });
  return () => {
    offReconnected();
    offBuilt();
  };
}
