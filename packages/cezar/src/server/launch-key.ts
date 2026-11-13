import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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
  const key = randomUUID();
  let fd: number | undefined;
  try {
    mkdirSync(dataDir, { recursive: true });
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const flags = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      try {
        fd = openSync(path, constants.O_RDWR | flags);
      } catch {
        // A readable, read-only persisted key must remain reusable.
        fd = openSync(path, constants.O_RDONLY | flags);
      }
      const opened = fstatSync(fd);
      const entry = lstatSync(path);
      // Also binds the open on platforms without O_NOFOLLOW (spec 011).
      if (!opened.isFile() || !entry.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) return key;
      const existing = readFileSync(fd, 'utf8').trim();
      if (existing) return existing;
    }
    // Pin permissions and writes to the opened file, never a replaced pathname.
    fchmodSync(fd, 0o600);
    const contents = `${key}\n`;
    let written = 0;
    while (written < contents.length) {
      const count = writeSync(fd, contents.slice(written), written, 'utf8');
      if (count === 0) throw new Error('launch-key write made no progress');
      written += count;
    }
    ftruncateSync(fd, key.length + 1);
  } catch {
    // non-fatal: the key still protects auto-start for this process lifetime
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
  }
  return key;
}
