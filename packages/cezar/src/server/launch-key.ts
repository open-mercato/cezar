import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Launch-key (spec 011): a random secret baked into the bookmarklets so only
 * pages that got it from THIS cockpit can auto-start a run via `/new?auto=1`.
 * A rogue web page can navigate the browser to localhost, but it cannot read
 * `.ai/cezar/launch-key` — without the key `/new` only prefills the form.
 */
export function ensureLaunchKey(dataDir: string): string {
  const path = join(dataDir, 'launch-key');
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing) return existing;
    }
  } catch {
    // unreadable — fall through and regenerate
  }
  const key = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600); // best-effort — mode is ignored on pre-existing files
  } catch {
    // non-fatal: the key still protects auto-start for this process lifetime
  }
  return key;
}
