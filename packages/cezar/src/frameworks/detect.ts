import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveFramework } from '@open-mercato/cezar-contract';
import { FALLBACK_FRAMEWORK_ID } from './builtins.ts';
import { readProjectFrameworkChoice } from './choice.ts';
import { FRAMEWORKS_SUBDIR, listBuiltinFrameworks } from './load.ts';

/**
 * Which framework new cards use (D6): an explicit `framework` in `.ai/cezar/config.json` wins
 * (an explicit `generic` included), else the first built-in whose `detect` paths all exist, else
 * Generic. File checks only — no network, never polled; callers run it when the board or New
 * card opens.
 */
export function resolveProjectFramework(repoRoot: string, dataDir: string): ActiveFramework {
  const builtins = listBuiltinFrameworks();
  const explicit = readProjectFrameworkChoice(dataDir);
  // An explicit choice naming nothing that exists (a deleted project file) falls through to
  // detection rather than leaving the board without a framework.
  if (explicit && (builtins.some((f) => f.id === explicit) || projectFileExists(dataDir, explicit))) {
    return { id: explicit, source: 'explicit' };
  }
  for (const f of builtins) {
    const detect = f.framework?.detect;
    if (!detect?.length) continue;
    if (detect.every((p) => existsSync(join(repoRoot, p)))) return { id: f.id, source: 'detected', detectedBy: detect[0] };
  }
  return { id: FALLBACK_FRAMEWORK_ID, source: 'fallback' };
}

function projectFileExists(dataDir: string, id: string): boolean {
  return ['.yaml', '.yml'].some((ext) => existsSync(join(dataDir, FRAMEWORKS_SUBDIR, `${id}${ext}`)));
}
