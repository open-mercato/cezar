import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so the mock fns exist before the hoisted `vi.mock` factories close over them.
const resolveRepoHandleMock = vi.hoisted(() => vi.fn());
const getRepoInfoMock = vi.hoisted(() => vi.fn());
// The forge module shells out to `gh`. Mocking it is the whole point of this file: what is under
// test is the WRAPPER's contract — background, never throwing — not the lookup itself, which has
// its own coverage in `server/forge/github.test.ts`.
// Partial: `forge/gitlab.ts` imports real constants from this module (its checks budget), and a
// bare factory would make those `undefined` for every importer in the same graph.
vi.mock('../server/forge/github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/forge/github.ts')>()),
  resolveRepoHandle: (...args: unknown[]) => resolveRepoHandleMock(...args),
}));
// The remote read is a `git` spawn for the same reason — the classification it feeds
// (`forgeKindOfRemote`, `parseRemote`) is REAL here, because that mapping is the fix under test.
vi.mock('../server/git.ts', () => ({
  getRepoInfo: (...args: unknown[]) => getRepoInfoMock(...args),
}));

import { armRepoHandle } from './arm-repo-handle.ts';
import { __setForgeHostsForTests } from '../server/forge/index.ts';

import type { RunStore } from './store.ts';

/**
 * `armRepoHandle` is the safety wrapper around the #945 repo lookup, and both of its call sites
 * are fire-and-forget — so a regression here is invisible to every other suite and surfaces only
 * as a boot that dies on a machine without `gh`. `AGENTS.md` makes that the rule it breaks:
 * "a missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit,
 * never fail the boot."
 */
describe('armRepoHandle (#945)', () => {
  beforeEach(() => {
    // No remote by default: an unclassified root takes the `gh` route, exactly as before.
    getRepoInfoMock.mockResolvedValue(null);
  });

  afterEach(() => {
    __setForgeHostsForTests(null);
    vi.clearAllMocks();
  });

  /** Just enough store to observe the one call this module makes. */
  const fakeStore = () => {
    const setRepoHandle = vi.fn();
    return { store: { setRepoHandle } as unknown as RunStore, setRepoHandle };
  };

  /** Let the promise chain inside `armRepoHandle` settle without the caller awaiting it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('hands a resolved handle to the store', async () => {
    resolveRepoHandleMock.mockResolvedValue({ owner: 'open-mercato', name: 'cezar' });
    const { store, setRepoHandle } = fakeStore();

    armRepoHandle(store, '/repo');
    await settle();

    expect(resolveRepoHandleMock).toHaveBeenCalledWith('/repo');
    expect(setRepoHandle).toHaveBeenCalledWith({ owner: 'open-mercato', name: 'cezar' });
  });

  it('passes a null handle through — "unknown" is a first-class answer, not a failure', async () => {
    // No `gh`, no remote, a non-git root, hosted mode. The store must be told, so it settles into
    // the unscoped (pre-#945) behavior rather than waiting forever for a handle.
    resolveRepoHandleMock.mockResolvedValue(null);
    const { store, setRepoHandle } = fakeStore();

    armRepoHandle(store, '/repo');
    await settle();

    expect(setRepoHandle).toHaveBeenCalledWith(null);
  });

  it('swallows a rejection instead of taking the boot down with it', async () => {
    // `resolveRepoHandle` answers null rather than throwing for the ordinary cases, so this is
    // belt-and-braces — which is exactly why it needs a test: without one, the `.catch` reads as
    // deletable, and deleting it turns any future throw into an unhandled rejection during boot.
    resolveRepoHandleMock.mockRejectedValue(new Error('gh exploded'));
    const { store, setRepoHandle } = fakeStore();

    expect(() => armRepoHandle(store, '/repo')).not.toThrow();
    await settle();

    expect(setRepoHandle).not.toHaveBeenCalled(); // unscoped, exactly as before #945
  });

  it('returns synchronously — boot never waits on the `gh` spawn', async () => {
    // The property both call sites depend on: a slow lookup must not delay opening a store.
    let release: (value: unknown) => void = () => {};
    resolveRepoHandleMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { store, setRepoHandle } = fakeStore();

    expect(armRepoHandle(store, '/repo')).toBeUndefined();
    expect(setRepoHandle).not.toHaveBeenCalled(); // still pending — and the caller already moved on

    release({ owner: 'open-mercato', name: 'cezar' });
    await settle();
    expect(setRepoHandle).toHaveBeenCalledWith({ owner: 'open-mercato', name: 'cezar' });
  });

  /**
   * Step 4.4-review-fix-2. `resolveRepoHandle` shells `gh repo view`, which never answers on a
   * GitLab project — so the store stayed handle-less there and `isRepoScopedRef` degraded to
   * "adopt anything", the exact defect #945 fixed for GitHub. A GitLab handle comes from the
   * remote instead, as the whole project path split at its last separator.
   */
  describe('on a GitLab project the handle comes from the remote', () => {
    it('arms the whole subgroup path, and never asks `gh` about it', async () => {
      getRepoInfoMock.mockResolvedValue({ root: '/repo', branch: 'main', remote: 'git@gitlab.com:group/sub/proj.git' });
      const { store, setRepoHandle } = fakeStore();

      armRepoHandle(store, '/repo');
      await settle();

      // `{owner, name}` rejoins to `group/sub/proj` — what `refUrlRepo` reads out of an MR URL,
      // and `host` scopes that path to this instance (Step 5.9).
      expect(setRepoHandle).toHaveBeenCalledWith({ owner: 'group/sub', name: 'proj', host: 'gitlab.com' });
      expect(resolveRepoHandleMock).not.toHaveBeenCalled();
    });

    it('arms a self-managed instance the same way, port and http scheme included', async () => {
      // Only the discovery cache can classify an on-prem host — the same map `resolveForge` reads.
      __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
      getRepoInfoMock.mockResolvedValue({
        root: '/repo',
        branch: 'main',
        remote: 'http://gitlab.acme.internal:8929/group/repo.git',
      });
      const { store, setRepoHandle } = fakeStore();

      armRepoHandle(store, '/repo');
      await settle();

      // The host is the instance's hostname, port-free — `parseRemote` keeps the port in `origin`
      // alone, and `isRepoScopedRef` compares hostnames (Step 5.9).
      expect(setRepoHandle).toHaveBeenCalledWith({
        owner: 'group',
        name: 'repo',
        host: 'gitlab.acme.internal',
      });
    });

    it('leaves a GitHub project on `gh repo view` — renames and redirects still resolve', async () => {
      getRepoInfoMock.mockResolvedValue({ root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' });
      resolveRepoHandleMock.mockResolvedValue({ owner: 'open-mercato', name: 'cezar' });
      const { store, setRepoHandle } = fakeStore();

      armRepoHandle(store, '/repo');
      await settle();

      expect(resolveRepoHandleMock).toHaveBeenCalledWith('/repo');
      // No `host` on a `gh`-resolved handle — the GitHub comparison stays path-only (Step 5.9).
      expect(setRepoHandle).toHaveBeenCalledWith({ owner: 'open-mercato', name: 'cezar' });
    });

    it('falls back to `gh` for a host nothing has classified yet', async () => {
      // A GitHub Enterprise host before discovery warms: unknown kind, so nothing changes.
      getRepoInfoMock.mockResolvedValue({ root: '/repo', branch: 'main', remote: 'git@ghe.corp.example:team/app.git' });
      resolveRepoHandleMock.mockResolvedValue(null);
      const { store, setRepoHandle } = fakeStore();

      armRepoHandle(store, '/repo');
      await settle();

      expect(resolveRepoHandleMock).toHaveBeenCalledWith('/repo');
      expect(setRepoHandle).toHaveBeenCalledWith(null);
    });
  });
});
