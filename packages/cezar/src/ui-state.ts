import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

/** Read `ui-state.json` on demand — never cached, never throws. */
export async function readUiState(repoRoot: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(uiStatePath(repoRoot), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
