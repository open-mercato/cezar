import { describe, expect, it, vi } from 'vitest';
import type { ProjectContexts } from '../server/project-context.ts';
import { workspaceDiskGuardDeps } from './disk-guard-workspace.ts';
import type { RunStore } from './store.ts';

// Spec 2026-11-19-worktree-disk-usage, decision 3: a disk check must never build a project's
// context — that prunes, retains and `recover()`s its runs.
describe('workspaceDiskGuardDeps', () => {
  const store = { listRuns: () => [] } as unknown as RunStore;
  const manager = { isActive: () => false };
  const boot = { id: 'boot', root: '/repos/boot', store, manager };

  it('opens only projects this process already has open', async () => {
    const context = vi.fn();
    const open = { id: 'open', root: '/repos/open', store, manager };
    const contexts = { peek: (id: string) => (id === 'open' ? open : undefined), context } as unknown as ProjectContexts;
    const deps = workspaceDiskGuardDeps({ boot, contexts, listProjects: async () => [] });

    expect((await deps.open('boot'))?.root).toBe('/repos/boot');
    expect((await deps.open('open'))?.root).toBe('/repos/open');
    expect(await deps.open('closed')).toBeUndefined();
    expect(context).not.toHaveBeenCalled();
  });
});
