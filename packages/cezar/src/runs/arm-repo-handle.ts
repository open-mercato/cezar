import { resolveRepoHandle } from '../server/forge/github.ts';

import type { RunStore } from './store.ts';

/**
 * Tell a freshly opened store which repository it belongs to (#945), in the background.
 *
 * Its own module for two reasons. It is the ONE place the fire-and-forget is written, so both
 * `RunStore.open` call sites that hold a repo root — `server/project-context.ts` and `openStore()`
 * in `index.ts` — cannot drift on how a `gh` failure is handled. And it keeps `store.ts` free of
 * any forge import: the store owns the *rule* (`isRepoScopedRef`), never the lookup.
 *
 * Deliberately not awaited by callers. `resolveRepoHandle` shells out to `gh`, and boot must never
 * wait on the network — a project whose handle is slow to resolve simply behaves as it did before
 * #945 until it arrives, at which point `setRepoHandle` heals what the un-scoped rule got wrong.
 * `resolveRepoHandle` already answers `null` rather than throwing for the ordinary no-`gh`/
 * no-remote/non-git cases; the `catch` is the belt-and-braces for the rest, because an unhandled
 * rejection here would take down a boot over a cosmetic chip.
 */
export function armRepoHandle(store: RunStore, repoRoot: string): void {
  void resolveRepoHandle(repoRoot)
    .then((handle) => store.setRepoHandle(handle))
    .catch(() => {
      // Unknown handle is a first-class state — leave the store unscoped (pre-#945 behavior).
    });
}
