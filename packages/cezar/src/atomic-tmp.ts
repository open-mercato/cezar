import { randomBytes } from 'node:crypto';

/**
 * The tmp path an atomic write stages through — UNIQUE PER WRITE, never a
 * fixed `${path}.tmp`. `~/.cezar/` and `.ai/cezar/` are shared by every cezar
 * process that touches them (a `serve` per repo, `cezar run`s, a settings
 * PUT), and two writers staging through the same tmp name interleave: writer B's `O_TRUNC` open can
 * empty the file between writer A's write and rename, so A renames a
 * truncated/half-written file into place — and B's own rename then throws
 * `ENOENT` on the name A consumed. The pid + random suffix gives every writer
 * its own staging file, so the only cross-process contention left is the
 * rename itself, which is atomic.
 */
export function atomicTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}
