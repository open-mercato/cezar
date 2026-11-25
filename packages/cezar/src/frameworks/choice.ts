import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readLifecycleConfigRaw, withLifecycleConfigLock } from '../worktree-lifecycle/config.ts';
import { atomicLifecycleWrite } from '../worktree-lifecycle/store.ts';

/**
 * The project's explicit framework choice: the optional `framework` key of `.ai/cezar/config.json`
 * (D6/D15). Absent = automatic. Read raw rather than through `configSchema`, so the key never
 * materializes a default and an older cezar's settings writes (which merge raw) keep it.
 */

const choiceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

/** The explicit choice, or undefined when absent, malformed, or the file cannot be read. */
export function readProjectFrameworkChoice(dataDir: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const parsed = choiceSchema.safeParse((raw as Record<string, unknown>).framework);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write (or with `null`, remove) the explicit choice, merging into the raw file under the same
 * lock as Settings' config writes. Throws when the existing file is unreadable or not JSON — a
 * user's hand-edited config is never overwritten.
 */
export async function writeProjectFrameworkChoice(repoRoot: string, framework: string | null): Promise<void> {
  await withLifecycleConfigLock(repoRoot, async () => {
    const path = join(repoRoot, '.ai', 'cezar', 'config.json');
    const raw = await readLifecycleConfigRaw(repoRoot);
    if (framework === null && !('framework' in raw)) return;
    const next = { ...raw };
    if (framework === null) delete next.framework;
    else next.framework = choiceSchema.parse(framework);
    await atomicLifecycleWrite(path, next);
  });
}
