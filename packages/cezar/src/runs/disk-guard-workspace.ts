// The disk guard's view of the workspace (spec 2026-11-19-worktree-disk-usage, decision 3): every
// registered project's root from the registry, and the trees of every project this process already
// has open — the disk is shared, so a tree in any of them may go. A closed project is never opened.
import { realpathSync } from 'node:fs';
import type { ProjectContexts, ProjectContextSource } from '../server/project-context.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import type { DiskGuardDeps, GuardProject, GuardRoot } from './disk-guard.ts';
import type { RunStore } from './store.ts';

interface BootProject {
  id: string;
  root: string;
  store: RunStore;
  manager: { isActive(runId: string): boolean; lifecycle?: GuardProject['lifecycle'] };
}

function sameRoot(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function workspaceDiskGuardDeps(opts: {
  boot: BootProject;
  contexts: ProjectContexts;
  listProjects: () => Promise<readonly ProjectContextSource[]>;
  loadConfig?: typeof loadWorkspaceConfig;
}): DiskGuardDeps {
  const { boot, contexts } = opts;
  const loadConfig = opts.loadConfig ?? loadWorkspaceConfig;
  const project = (id: string, root: string, store: RunStore, manager: BootProject['manager']): GuardProject => ({
    id,
    root,
    store,
    isLive: (runId) => manager.isActive(runId),
    ...(manager.lifecycle ? { lifecycle: manager.lifecycle } : {}),
  });
  return {
    roots: async () => {
      const registered = await opts.listProjects().catch(() => [] as ProjectContextSource[]);
      const others: GuardRoot[] = registered
        .filter((p) => p.status !== 'missing' && p.id !== boot.id && !sameRoot(p.root, boot.root))
        .map((p) => ({ id: p.id, root: p.root }));
      return [{ id: boot.id, root: boot.root }, ...others];
    },
    open: async (id) => {
      if (id === boot.id) return project(boot.id, boot.root, boot.store, boot.manager);
      // Only a project this process already opened: building one prunes, retains and `recover()`s
      // its runs, which a disk check must never do (see `GET /workspace/runs-index`).
      const ctx = contexts.peek(id);
      return ctx ? project(ctx.id, ctx.root, ctx.store, ctx.manager) : undefined;
    },
    thresholds: async () => (await loadConfig()).resources.diskGuard,
  };
}
