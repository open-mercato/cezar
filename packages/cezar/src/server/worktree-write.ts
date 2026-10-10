import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { FILE_CONTENT_CAP, fileHash, readWorktreePath, type FilesResult } from './git-changes.ts';

/**
 * The write half of the task workspace's Code view (spec
 * `.ai/specs/2026-07-20-worktree-file-editing.md`): saving one existing text file in place, and —
 * further down — creating, deleting and renaming one.
 *
 * Resolution goes THROUGH `readWorktreePath`, so the write inherits the read's containment
 * (traversal, symlinks, symlinked parents, the root `.git`) from one implementation instead of a
 * second one that drifts. What a write needs on top is here, and none of it is inherited:
 *
 *   - a deny rule for `.git` and `node_modules` at ANY depth — the read only refuses the root
 *     `.git`, and writing `sub/.git/hooks/pre-commit` or an installed dependency is code
 *     execution, not editing;
 *   - a stale-base guard (`baseHash`), because the other writer is an agent that will not notice;
 *   - an atomic tmp+rename, so a crashed write cannot truncate a source file.
 *
 * Like the rest of the git plumbing it never throws; the route maps `kind` to a status.
 */

export type WriteResult =
  | { ok: true; path: string; size: number; hash: string }
  /** `refused`: this target is not editable. `conflict`: it changed since it was read.
   *  `failed`: the filesystem said no. */
  | { ok: false; kind: 'refused' | 'conflict' | 'failed'; error: string };

export const WRITE_CONFLICT = 'file changed on disk since it was opened — reload to see the current content';

/** Directories whose contents are EXECUTED by git or the toolchain. Compared after `foldSegment`. */
const DENIED_SEGMENTS: Record<string, string> = {
  '.git': 'git internals are not editable',
  node_modules: 'installed dependencies are not editable',
};

/** A path segment as a case-insensitive filesystem would match it: Windows also ignores trailing
 *  dots and spaces, so `.GIT` and `.git.` both name the directory git reads. Folding on every
 *  platform costs nothing — no legitimate edit target is spelled that way. */
function foldSegment(segment: string): string {
  return segment.toLowerCase().replace(/[. ]+$/, '');
}

function deniedReason(relPath: string): string | null {
  for (const segment of relPath.split(/[\\/]/)) {
    const reason = DENIED_SEGMENTS[foldSegment(segment)];
    if (reason) return reason;
    // NTFS reads `name:stream` as a stream of `name`, and `.git::$INDEX_ALLOCATION` as the `.git`
    // directory itself — a spelling the fold above cannot see through.
    if (process.platform === 'win32' && segment.includes(':')) return `not a valid file name: ${segment}`;
  }
  return null;
}

/** The deny rule over the path the OS actually resolves: a Windows 8.3 short name (`GIT~1`)
 *  spells `.git` without containing it, and only the OS's own realpath (which the promises API
 *  is) expands it. `existing` must exist. */
async function realDeniedReason(root: string, existing: string): Promise<string | null> {
  const [realAbs, realRoot] = await Promise.all([realpath(existing), realpath(resolve(root))]);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) return 'path escapes the worktree';
  return deniedReason(realAbs.slice(realRoot.length).split(sep).join('/'));
}

/**
 * Why a file `readWorktreePath` resolved cannot be edited, or null when it can. Shared by the
 * `GET` (which reports it as `editable` / `editableReason`) and the write, so the Edit button and
 * the refusal can never disagree about a file.
 */
export function editRefusal(file: Extract<FilesResult, { kind: 'file' }>): string | null {
  const denied = deniedReason(file.path);
  if (denied) return denied;
  if (file.binary) return 'binary files are not editable';
  if (file.tooLarge) return 'file is too large to edit';
  // A latin-1 file passes the NUL sniff, decodes with U+FFFD and would be written back AS those
  // replacements — silently corrupting a file the user only meant to touch.
  if (file.utf8 === false) return 'file is not valid UTF-8 — saving it would corrupt it';
  return null;
}

export async function writeWorktreeFile(
  root: string,
  relPath: string,
  content: string,
  baseHash: string,
  contentCap = FILE_CONTENT_CAP,
): Promise<WriteResult> {
  const refuse = (error: string): WriteResult => ({ ok: false, kind: 'refused', error });

  const bytes = Buffer.from(content, 'utf8');
  // A lone surrogate has no UTF-8 encoding; `Buffer.from` substitutes U+FFFD for it without a word.
  if (bytes.toString('utf8') !== content) return refuse('content is not valid Unicode text');
  if (bytes.length > contentCap) return refuse(`content is too large to save (${bytes.length} bytes)`);

  const target = await readWorktreePath(root, relPath, contentCap);
  if (target.kind === 'invalid' || target.kind === 'missing') return refuse(target.error);
  if (target.kind === 'dir') return refuse(`not a file: ${target.path || '/'}`);
  const refusal = editRefusal(target);
  if (refusal) return refuse(refusal);

  const abs = join(resolve(root), target.path);
  try {
    const denied = await realDeniedReason(root, abs);
    if (denied) return refuse(denied);
  } catch {
    return refuse(`no such file or directory in the worktree: ${relPath}`);
  }

  if (target.hash !== baseHash) return { ok: false, kind: 'conflict', error: WRITE_CONFLICT };

  // Beside the target, so the rename never crosses a filesystem; recognizable, because nothing
  // sweeps it if the process dies between the two calls.
  const tmp = join(dirname(abs), `.${basename(abs)}.cez-tmp-${randomBytes(6).toString('hex')}`);
  try {
    const { mode } = await stat(abs);
    await writeFile(tmp, bytes, { flag: 'wx', mode });
    await chmod(tmp, mode); // `mode` above is masked by the umask; an executable must stay one
    // The stale-base check once more, as late as it can run. This NARROWS the window in which an
    // agent write is destroyed unseen; nothing an external process honors can close it.
    if (fileHash(await readFile(abs)) !== baseHash) {
      await rm(tmp, { force: true });
      return { ok: false, kind: 'conflict', error: WRITE_CONFLICT };
    }
    await replaceFile(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    return { ok: false, kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, path: target.path, size: bytes.length, hash: fileHash(bytes) };
}

/** `rename(2)` replaces a symlink in its final component rather than following it, which is what
 *  keeps a target swapped for a link after resolution from redirecting the write. Exported so a
 *  test pins that property against a future switch to a plain `writeFile`. */
export async function replaceFile(from: string, to: string): Promise<void> {
  await rename(from, to);
}

/**
 * Store `bytes` as a loose git blob and return its id, or null when git cannot (not a repo, no
 * git). This is the recovery record for a hand edit: the agent sends no `baseHash`, so its next
 * write can destroy what the user saved, and `git cat-file -p <id>` brings it back.
 *
 * `hash-object` rather than a commit on purpose — it touches neither the index nor a ref, so it
 * cannot collide with the `index.lock` of a `git add` the agent is running in the same worktree,
 * and it covers untracked and ignored files, which no checkout could restore. An unreachable
 * blob lives until git's own gc prunes it (two weeks by default).
 */
export function recordEditBlob(cwd: string, bytes: Uint8Array): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn('git', ['hash-object', '-w', '--no-filters', '--stdin'], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 && /^[0-9a-f]{40,64}$/.test(out.trim()) ? out.trim() : null));
    child.stdin.on('error', () => undefined);
    child.stdin.end(bytes);
  });
}

// ---- create, delete, rename (spec §Revision 2026-10-10, step 3) -------------------------------

type Refusal = { ok: false; kind: 'refused' | 'failed'; error: string };
const refused = (error: string): Refusal => ({ ok: false, kind: 'refused', error });
const failed = (err: unknown): Refusal => ({
  ok: false,
  kind: 'failed',
  error: err instanceof Error ? err.message : String(err),
});
const exists = (path: string) => lstat(path).then(() => true, () => false);

/**
 * Resolve a path that must NOT exist yet — a file about to be created, or a rename's destination.
 * `readWorktreePath` cannot do this (a missing path is its refusal), so the same containment is
 * spelled here for a target with nothing on disk to inspect: lexical containment and the deny
 * rule over the path as written, then real containment and the deny rule again over the nearest
 * ancestor that does exist — which is where a symlinked parent would redirect the write.
 */
async function resolveNewPath(
  root: string,
  relPath: string,
): Promise<{ ok: true; abs: string; path: string } | Refusal> {
  if (relPath.includes('\0')) return refused('invalid path');
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath);
  if (!abs.startsWith(rootAbs + sep)) return refused(`path escapes the worktree: ${relPath}`);
  const path = abs.slice(rootAbs.length + 1).split(sep).join('/');
  const denied = deniedReason(path);
  if (denied) return refused(denied);
  if (await exists(abs)) return refused(`already exists: ${path}`);

  let ancestor = dirname(abs);
  while (ancestor !== rootAbs && !(await exists(ancestor))) ancestor = dirname(ancestor);
  try {
    if (!(await stat(ancestor)).isDirectory()) return refused(`a parent of ${path} is not a directory`);
    const realDenied = await realDeniedReason(root, ancestor);
    if (realDenied) return refused(realDenied);
  } catch {
    return refused(`no such directory in the worktree: ${relPath}`);
  }
  return { ok: true, abs, path };
}

/** Create a new text file, with whatever directories its path names. Never overwrites: the
 *  exclusive flag makes "it appeared in the meantime" a refusal rather than a lost file. */
export async function createWorktreeFile(
  root: string,
  relPath: string,
  content: string,
  contentCap = FILE_CONTENT_CAP,
): Promise<{ ok: true; path: string; size: number; hash: string } | Refusal> {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.toString('utf8') !== content) return refused('content is not valid Unicode text');
  if (bytes.length > contentCap) return refused(`content is too large to save (${bytes.length} bytes)`);
  const target = await resolveNewPath(root, relPath);
  if (!target.ok) return target;
  try {
    await mkdir(dirname(target.abs), { recursive: true });
    await writeFile(target.abs, bytes, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return refused(`already exists: ${target.path}`);
    return failed(err);
  }
  return { ok: true, path: target.path, size: bytes.length, hash: fileHash(bytes) };
}

/** An existing regular file that may be removed or moved: contained, not a symlink, and not under
 *  a directory git or the toolchain executes. Binary and oversized files qualify — deleting or
 *  renaming one does not decode it. */
async function resolveExistingFile(
  root: string,
  relPath: string,
): Promise<{ ok: true; abs: string; path: string } | Refusal> {
  const target = await readWorktreePath(root, relPath);
  if (target.kind === 'invalid' || target.kind === 'missing') return refused(target.error);
  if (target.kind === 'dir') return refused(`not a file: ${target.path || '/'} — directories are not handled here`);
  const abs = join(resolve(root), target.path);
  try {
    const denied = deniedReason(target.path) ?? (await realDeniedReason(root, abs));
    if (denied) return refused(denied);
  } catch {
    return refused(`no such file or directory in the worktree: ${relPath}`);
  }
  return { ok: true, abs, path: target.path };
}

/**
 * Delete one file. Its bytes are stored as a git blob FIRST (`blob`, null outside a repository),
 * because a delete from a browser has no trash to fall back on and an untracked or ignored file
 * has no commit either — `git cat-file -p <blob>` is the way back.
 */
export async function deleteWorktreeFile(
  root: string,
  relPath: string,
): Promise<{ ok: true; path: string; blob: string | null } | Refusal> {
  const target = await resolveExistingFile(root, relPath);
  if (!target.ok) return target;
  try {
    const blob = await recordEditBlob(root, await readFile(target.abs));
    await unlink(target.abs);
    return { ok: true, path: target.path, blob };
  } catch (err) {
    return failed(err);
  }
}

/** Move one file to a path that does not exist yet, creating the directories it names. The
 *  destination is checked, not locked: something creating that exact name in the milliseconds
 *  between the check and the rename would be replaced — the same accepted window as a save. */
export async function renameWorktreeFile(
  root: string,
  from: string,
  to: string,
): Promise<{ ok: true; from: string; to: string } | Refusal> {
  const source = await resolveExistingFile(root, from);
  if (!source.ok) return source;
  const target = await resolveNewPath(root, to);
  if (!target.ok) return target;
  try {
    await mkdir(dirname(target.abs), { recursive: true });
    await rename(source.abs, target.abs);
  } catch (err) {
    return failed(err);
  }
  return { ok: true, from: source.path, to: target.path };
}
