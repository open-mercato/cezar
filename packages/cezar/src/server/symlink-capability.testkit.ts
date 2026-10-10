import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Can this process create a symlink to a FILE?
 *
 * Always true on Linux and macOS. On Windows a true symlink needs Developer Mode or an elevated
 * process (`EPERM` otherwise), so a case that is ABOUT a file symlink gates itself on this with
 * `it.skipIf(!canSymlinkFiles)` — probed once, by trying, instead of assumed from the platform, so
 * a Windows machine that can make them still runs the case.
 *
 * Directory links do not need this: pass `'junction'` as `symlink`'s third argument, which an
 * unprivileged Windows user may create and which every other platform ignores.
 */
export const canSymlinkFiles: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-symlink-probe-'));
  try {
    const target = join(dir, 'target');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
