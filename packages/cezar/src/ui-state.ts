import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UiState } from '@open-mercato/cezar-contract';
import { readWorkspaceUiState } from './workspace/ui-state.ts';

/**
 * `.ai/cezar/ui-state.json` — small GUI preferences the cockpit persists (files, not a DB).
 * The server owns the schema and the writes (`PUT /api/ui-state` in `src/server/server.ts`);
 * this is the shared read path, so the CLI can honour a preference the cockpit set (#391's
 * `dismissedSkillsBanner`) without a second notion of where the file lives.
 *
 * Same zero-config rule as `src/config.ts`: missing, unreadable or malformed all degrade to
 * `{}` — an absent preference, never a throw, never a blocked startup.
 */
export function uiStatePath(repoRoot: string): string {
  return join(repoRoot, '.ai/cezar', 'ui-state.json');
}

/**
 * Read `ui-state.json` on demand — never cached, never throws. The old
 * workspace-level `importedSkills` value seeds projects without a local
 * selection; a project-local value always takes precedence.
 *
 * Typed by the CONTRACT (`UiState`), not by a loose record: `GET /api/v1/ui-state` answers this
 * value verbatim, so a `Record<string, unknown>` here made the route name no key at all and the
 * per-route parity guard vacuous — the same defect `healthSnapshot` had. `UiState` is a
 * `z.looseObject`, so the index signature (and with it the round-trip promise of
 * BACKWARD_COMPATIBILITY.md §3) survives; what it adds is the NAMES of the keys the server knows.
 *
 * The cast is unchanged in kind — the file is user-editable JSON and is deliberately NOT parsed
 * through the schema, because a single malformed pref must not discard the whole bag (§3). What
 * the type asserts is the wire shape the route promises; the write side (`PUT /ui-state`, validated
 * by `uiStateBody`) is what actually enforces it.
 */
export async function readUiState(repoRoot: string): Promise<UiState> {
  let state: UiState = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(uiStatePath(repoRoot), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed as UiState;
  } catch {
    // Missing/unreadable local state remains an empty preference bag.
  }

  if (Array.isArray(state.importedSkills)) return state;
  const legacy = await readWorkspaceUiState();
  return Array.isArray(legacy.importedSkills) ? { ...state, importedSkills: legacy.importedSkills } : state;
}
