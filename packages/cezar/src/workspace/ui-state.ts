import { readFile } from 'node:fs/promises';
import type { WorkspaceUiState } from '@open-mercato/cezar-contract';
import { workspaceUiStatePath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

/**
 * `~/.cezar/ui-state.json` — global GUI state, the workspace twin of the
 * per-repo `.ai/cezar/ui-state.json` (spec 2026-07-20-multi-project-workspace,
 * Data Model). Same split as `src/ui-state.ts`: this module owns the tolerant
 * read and the atomic write; the schema and key cap live at the route boundary
 * (`GET/PUT /api/workspace/ui-state`, step 2.7). The state is an opaque
 * `.passthrough()`-style bag — cross-project prefs (appearance, notifications,
 * per-project sidebar collapse) live here; project-scoped prefs stay in each
 * repo's own file.
 */

/** Read `~/.cezar/ui-state.json` on demand — never cached, never throws.
 *  Missing, unreadable, malformed, or non-object all degrade to `{}`.
 *
 *  Typed by the CONTRACT (`WorkspaceUiState`) for the same reason as its per-repo twin in
 *  `src/ui-state.ts`: `GET /api/v1/workspace/ui-state` answers this value verbatim, so a loose
 *  record left the route naming no key. The schema is a `z.looseObject`, so unknown prefs keep
 *  round-tripping (BACKWARD_COMPATIBILITY.md §3) — the type only adds the known names. */
export async function readWorkspaceUiState(
  path: string = workspaceUiStatePath(),
): Promise<WorkspaceUiState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as WorkspaceUiState)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read-modify-write for `~/.cezar/ui-state.json`, written with the same atomic
 * per-writer tmp+rename `0600` pattern (dir `0700`) as
 * `mergeWriteWorkspaceConfig` (`atomicWriteJsonSync` — one shared writer, so
 * the unique-tmp rule cannot drift between the two files). A missing or
 * corrupt file merges from `{}`. The mutator may mutate its argument in place
 * or return a replacement. Throws on write failure (e.g. a read-only home) —
 * degrading is the caller's policy, per house rules.
 *
 * Path resolved once, before the `await`, for the same reason as
 * `mergeWriteWorkspaceConfig`: a `CEZ_HOME` that changes mid-flight must not be
 * able to send the read and the write to two different files.
 */
export async function mergeWriteWorkspaceUiState(
  mutator: (state: WorkspaceUiState) => WorkspaceUiState | void,
): Promise<WorkspaceUiState> {
  const path = workspaceUiStatePath();
  const current = await readWorkspaceUiState(path);
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(path, next);
  return next;
}
