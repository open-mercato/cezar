import { forgeKindOfRemote, parseRemote } from '../server/forge/index.ts';
import { resolveRepoHandle } from '../server/forge/github.ts';
import { getRepoInfo } from '../server/git.ts';

import type { RepoHandle, RunStore } from './store.ts';

/**
 * Which repository a project IS, for the #945 guard — whatever forge it lives on.
 *
 * GitHub keeps asking `gh repo view` (`resolveRepoHandle`), byte for byte as before: `gh` resolves
 * the handle the way GitHub itself does, following renames and redirects, which the remote URL
 * alone cannot. Every other classified forge is answered from the remote, because `gh repo view`
 * never answers OFF GitHub — it was the only producer, so on a GitLab project the store stayed
 * handle-less and `isRepoScopedRef` degraded to `true` for every URL: the guard was inert exactly
 * where the spec had just taught the tier to recognize merge requests (spec
 * 2026-08-10-forge-provider-adapters, Step 4.4-review-fix-2).
 *
 * The GitLab identity is the whole project PATH (`group/sub/proj`), not a two-part slug — that is
 * what `refUrlRepo` reads out of a merge-request URL — so the handle is the path split at its last
 * separator, which `isRepoScopedRef` rejoins into exactly that string.
 *
 * It carries the instance HOST too (Step 5.9): a GitLab ref URL matches on any host, so without it
 * a project on `gitlab.com/acme/widgets` adopted a mirror's `gitlab.internal.corp/acme/widgets`
 * merge request as its own subject. `gh repo view` answers no host, so the GitHub branch below
 * keeps arming a host-less handle and its comparison stays path-only, exactly as before.
 *
 * An unclassified host (no remote, a local path, a GitHub Enterprise host before discovery has
 * warmed) falls through to `gh` as it always did, and an unparseable remote answers `null` — the
 * documented "unknown handle" state, which is pre-#945 behavior, never an error.
 */
async function resolveForgeRepoHandle(repoRoot: string): Promise<RepoHandle | null> {
  const remote = (await getRepoInfo(repoRoot))?.remote;
  if (forgeKindOfRemote(remote) !== 'gitlab') return resolveRepoHandle(repoRoot);
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  const cut = parsed.path.lastIndexOf('/');
  return cut <= 0
    ? null
    : { owner: parsed.path.slice(0, cut), name: parsed.path.slice(cut + 1), host: parsed.host };
}

/**
 * Tell a freshly opened store which repository it belongs to (#945), in the background.
 *
 * Its own module for two reasons. It is the ONE place the fire-and-forget is written, so both
 * `RunStore.open` call sites that hold a repo root — `server/project-context.ts` and `openStore()`
 * in `index.ts` — cannot drift on how a `gh` failure is handled. And it keeps `store.ts` free of
 * any forge import: the store owns the *rule* (`isRepoScopedRef`), never the lookup.
 *
 * Deliberately not awaited by callers. The lookup above shells out (`git remote get-url`, and on
 * GitHub `gh`), and boot must never wait on the network — a project whose handle is slow to
 * resolve simply behaves as it did before #945 until it arrives, at which point `setRepoHandle`
 * heals what the un-scoped rule got wrong. `getRepoInfo`/`resolveRepoHandle` already answer
 * `null`/`undefined` rather than throwing for the ordinary no-`gh`/no-remote/non-git cases; the
 * `catch` is the belt-and-braces for the rest, because an unhandled rejection here would take
 * down a boot over a cosmetic chip.
 */
export function armRepoHandle(store: RunStore, repoRoot: string): void {
  void resolveForgeRepoHandle(repoRoot)
    .then((handle) => store.setRepoHandle(handle))
    .catch(() => {
      // Unknown handle is a first-class state — leave the store unscoped (pre-#945 behavior).
    });
}
