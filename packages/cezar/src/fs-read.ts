import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, type Stats } from 'node:fs';

// The model owns the worktree, so a path that was a regular file at lstat time can be a symlink
// by the time a second call opens it (CodeQL js/file-system-race). Read through ONE descriptor
// that never follows a final symlink, and never blocks on a FIFO.
const NO_FOLLOW_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export type HarnessFsEntry =
  | { kind: 'symlink'; target: string }
  /** `content` is null when the file is larger than the caller's `maxBytes`. */
  | { kind: 'file'; stat: Stats; content: Buffer | null }
  | { kind: 'other'; stat: Stats };

/** Read `path` without following a final symlink. Throws like `readFileSync` (ENOENT, EACCES…). */
export function readHarnessFsEntry(path: string, maxBytes = Number.POSITIVE_INFINITY): HarnessFsEntry {
  let fd: number;
  try {
    fd = openSync(path, NO_FOLLOW_READ);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP (Linux, macOS) / EMLINK (FreeBSD): the last component is a symlink.
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'symlink', target: readlinkSync(path) };
    // Sockets and devices refuse open(2); they are still entries, never content.
    if (code === 'ENXIO' || code === 'EOPNOTSUPP' || code === 'ENODEV') return { kind: 'other', stat: lstatSync(path) };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: 'other', stat };
    if (stat.size > maxBytes) return { kind: 'file', stat, content: null };
    const content = readFileSync(fd);
    return { kind: 'file', stat, content: content.length > maxBytes ? null : content };
  } finally {
    closeSync(fd);
  }
}

/** A regular file's bytes (following symlinks — for trusted, cezar-owned trees), read through one
 *  descriptor; null for anything that is not a regular file or is larger than `maxBytes`. */
export function readRegularFileFollowing(path: string, maxBytes = Number.POSITIVE_INFINITY): Buffer | null {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const content = readFileSync(fd);
    return content.length > maxBytes ? null : content;
  } finally {
    closeSync(fd);
  }
}
