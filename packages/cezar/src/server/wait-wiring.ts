import type { RunStore } from '../runs/store.ts';
import { WaitResolver, type WaitCreateTarget, type WaitProjectContext } from '../workspace/waits.ts';
import type { ProjectContext } from './project-context.ts';

/**
 * Wire the workspace wait resolver into the project context registry (spec
 * `.ai/specs/2026-10-05-cross-task-waits.md`, step 4). One resolver per server:
 *
 *  - every store is subscribed the moment it opens (`onStoreCreated` — before its manager
 *    recovers, so a target settling during recovery is heard), the boot store at once;
 *  - every built context runs the catch-up (`onContextBuilt`), the boot one at once;
 *  - the boot context is NOT in the lazy map, so `peek`/`build` answer it themselves.
 *
 * Deliberately NOT wired to context disposal: `disposeAll()` is process shutdown, and resolving
 * edges there would cancel every cross-project wait on every restart. Project REMOVAL is a
 * separate, explicit call (`resolver.projectRemoved`) from the removal route.
 *
 * The boot sweep is left to the caller (`resolver.bootSweep()`), because it reads the registry.
 */
export interface WaitContextsSource {
  onStoreCreated(listener: (store: RunStore, projectId: string) => void): () => void;
  onContextBuilt(listener: (ctx: ProjectContext) => void): () => void;
  ids(): string[];
  peek(projectId: string): ProjectContext | undefined;
  context(projectId: string): Promise<ProjectContext>;
}

export function connectWaitResolver(options: {
  bootContext: WaitProjectContext;
  contexts: WaitContextsSource;
  /** Alias resolution: `default` and the boot project's registry id both name the boot context. */
  canonical: (projectId: string) => Promise<string>;
  listProjects: () => Promise<ReadonlyArray<{ id: string; root: string; status: string }>>;
  createTarget?: WaitCreateTarget;
}): { resolver: WaitResolver; disconnect: () => void } {
  const { bootContext, contexts } = options;
  const resolver = new WaitResolver({
    canonical: options.canonical,
    peek: (id) => (id === bootContext.id ? bootContext : contexts.peek(id)),
    build: async (id) => (id === bootContext.id ? bootContext : contexts.context(id)),
    listProjects: options.listProjects,
    ...(options.createTarget ? { createTarget: options.createTarget } : {}),
  });
  const offStore = contexts.onStoreCreated((store, projectId) => resolver.attachStore(projectId, store));
  const offBuilt = contexts.onContextBuilt((ctx) => resolver.contextBuilt(ctx.id));
  resolver.contextBuilt(bootContext.id);
  for (const id of contexts.ids()) resolver.contextBuilt(id);
  return {
    resolver,
    disconnect: () => {
      offStore();
      offBuilt();
      resolver.dispose();
    },
  };
}
