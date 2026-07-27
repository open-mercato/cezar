import { readFile } from 'node:fs/promises';
import { workspaceUiStatePath } from '../paths.js';
import { atomicWriteJsonSync } from './config.js';

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
 *  Missing, unreadable, malformed, or non-object all degrade to `{}`. */
export async function readWorkspaceUiState(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workspaceUiStatePath(), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
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
 */
export async function mergeWriteWorkspaceUiState(
  mutator: (state: Record<string, unknown>) => Record<string, unknown> | void,
): Promise<Record<string, unknown>> {
  const current = await readWorkspaceUiState();
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(workspaceUiStatePath(), next);
  return next;
}
