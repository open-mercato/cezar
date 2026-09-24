import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolveTaskDiffBase, type RepointedHead } from '../git-diff-base.ts';
import { isSafeGitRef } from '../git-refs.ts';

/**
 * Session git plumbing for the cockpit's Changes & Files tabs (redesign spec
 * `.ai/specs/2026-07-14-cockpit-ui-redesign.md` §"Git/session API additions").
 *
 * Structured diff (`collectChanges`), worktree browsing (`readWorktreePath`),
 * commit-all and push — all against an arbitrary directory so the same
 * helpers serve a task worktree today and the main working tree (Step 1.3).
 *
 * Policy mirrors `src/git-worktree.ts`: helpers never throw; every git
 * failure comes back as `{ ok:false, error }` with git's own words, and the
 * route layer turns that into a 409 + human-readable reason (never HTML,
 * never a 500 for a predictable git failure).
 */

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw — degradation is the caller's policy. `env` overrides (e.g. a scratch
 *  `GIT_INDEX_FILE`) merge over the process env. */
function git(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (err, stdout, stderr) => resolvePromise({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** First line of git's stderr (or stdout) as a one-line human reason. */
function gitReason(res: GitResult, fallback: string): string {
  const text = (res.stderr.trim() || res.stdout.trim()).split('\n')[0]?.trim();
  return text || fallback;
}

// ---- structured changes -----------------------------------------------------

/** Per-file patch cap — the GUI shows a "truncated" note past this. */
const PATCH_CAP = 200_000;

export interface ChangedFile {
  path: string;
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  adds: number;
  dels: number;
  binary: boolean;
  /** True when `path`'s extension is one the raw-bytes route (`/files?raw=1`) will serve as an
   *  `<img>` (#365) — lets the diff pane preview it inline instead of the "Binary file" note,
   *  even for extensions (SVG) git itself doesn't flag `binary`. Present only when true. */
  image?: boolean;
  patch: string;
}

export interface ChangesPayload {
  files: ChangedFile[];
  stat: { adds: number; dels: number; files: number };
  /** Present when a run worktree was repointed away from the task branch (#591). In that case the
   *  payload is intentionally limited to uncommitted changes instead of attributing the
   *  checked-out branch's history to this task. */
  repointedHead?: RepointedHead;
}

export type ChangesResult = { ok: true; changes: ChangesPayload } | { ok: false; error: string };

interface NumstatEntry {
  adds: number;
  dels: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}

/** Parse `git diff --numstat -z -M`: `adds TAB dels TAB path NUL`, or for a
 *  rename/copy `adds TAB dels TAB NUL old NUL new NUL`. Binary files report
 *  `-` for both counters. Exported for tests. */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i] ?? '';
    if (!head) {
      i += 1;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(head);
    if (!m) {
      i += 1;
      continue;
    }
    const binary = m[1] === '-';
    const adds = binary ? 0 : Number(m[1]);
    const dels = m[2] === '-' ? 0 : Number(m[2]);
    if (m[3]) {
      entries.push({ adds, dels, binary, path: m[3] });
      i += 1;
    } else {
      entries.push({ adds, dels, binary, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 3;
    }
  }
  return entries;
}

interface NameStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
}

/** Parse `git diff --name-status -z -M`: `X NUL path NUL`, renames/copies
 *  `Rnnn NUL old NUL new NUL`. Exported for tests. */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i] ?? '';
    if (!status) {
      i += 1;
      continue;
    }
    if (/^[RC]/.test(status)) {
      entries.push({ status, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 3;
    } else {
      entries.push({ status, path: tokens[i + 1] ?? '' });
      i += 2;
    }
  }
  return entries;
}

/** Split one `git diff --patch` blob into per-file sections, in git's file
 *  order (the same order `--numstat`/`--name-status` use). Exported for tests. */
export function splitPatch(patch: string): string[] {
  if (!patch.trim()) return [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) starts.push(m.index);
  return starts.map((start, idx) => patch.slice(start, starts[idx + 1] ?? patch.length));
}

/** Undo git's C-style path quoting (`core.quotePath`): git wraps paths with
 *  special bytes in double-quotes and escapes `\`, `"`, `\t`, `\n`, `\r`, `\f`
 *  plus octal `\NNN` byte escapes. Unquoted input (the common ASCII case, and
 *  anything containing only a space) is returned verbatim. Octal escapes are
 *  decoded per byte, which is lossy for multibyte UTF-8 names — those rare
 *  paths simply miss the map and fall back to positional matching below. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\([\\"tnrf])|\\([0-7]{3})/g, (_m, esc: string | undefined, oct: string | undefined) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    switch (esc) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'f':
        return '\f';
      default:
        return esc ?? '';
    }
  });
}

/** The new-side ("b/") path a single `git diff` section describes, or null when
 *  it can't be resolved. Renames/copies report their target; a deletion reports
 *  its removed ("a/") path — the exact path `git diff --name-status` lists for
 *  the same entry, so the two associate by path. The `---`/`+++` lines carry one
 *  path each (never ambiguous, even with spaces); only binary/mode-only/submodule
 *  sections, which lack them, fall back to the `diff --git` header. */
function sectionPath(section: string): string | null {
  const renameTo = section.match(/^rename to (.+)$/m) ?? section.match(/^copy to (.+)$/m);
  if (renameTo) return unquoteGitPath(renameTo[1] ?? '');
  const plus = section.match(/^\+\+\+ (.+)$/m);
  if (plus && plus[1] !== '/dev/null') return stripSidePrefix(unquoteGitPath(plus[1] ?? ''));
  const minus = section.match(/^--- (.+)$/m);
  if (minus && minus[1] !== '/dev/null') return stripSidePrefix(unquoteGitPath(minus[1] ?? ''));
  const nl = section.indexOf('\n');
  const header = nl < 0 ? section : section.slice(0, nl);
  const quoted = header.match(/^diff --git (?:"a\/.*"|a\/\S+) (?:"b\/(.*)"|b\/(\S+))$/);
  if (quoted) return unquoteGitPath(quoted[1] != null ? `"${quoted[1]}"` : (quoted[2] ?? ''));
  return null;
}

/** Strip the single leading `a/` or `b/` diff prefix (a real path segment named
 *  `a`/`b` keeps its later segments — only the first prefix is removed). */
function stripSidePrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

/** Map each `git diff --patch` section to the file path it describes, so a file's
 *  patch is looked up by path rather than by position. This is robust to the two
 *  listings (`--name-status` and `--patch`) disagreeing on file count — the case
 *  where positional matching used to blank *every* file's patch. Exported for tests. */
export function patchByPath(sections: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    const path = sectionPath(section);
    if (path != null && !map.has(path)) map.set(path, section);
  }
  return map;
}

function statusWord(letter: string): ChangedFile['status'] {
  switch (letter[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      // M, T (typechange), U — the GUI treats them all as "modified".
      return 'modified';
  }
}

/**
 * Structured "what changed here" for a directory vs its base branch:
 * committed + uncommitted + untracked (via `add -N`), anchored by the shared
 * `resolveTaskDiffBase` rule (`src/git-diff-base.ts`) — the merge-base against
 * the freshest base ref, so the diff stays *this task's* changes even after the
 * base moves on, and the branch's state at `runStartedAt` when the agent
 * repointed the worktree onto another branch (#591, #751).
 * `worktreeShortstat` resolves through the same helper; the text-blob `/diff`
 * endpoint (`worktreeDiff`) deliberately does not — see its own note.
 */
export async function collectChanges(
  dir: string,
  baseBranch: string,
  opts: {
    patchCap?: number;
    intentToAdd?: boolean;
    taskBranch?: string;
    runStartedAt?: string;
  } = {},
): Promise<ChangesResult> {
  if (!isSafeGitRef(baseBranch)) return { ok: false, error: 'refusing option-like base ref' };
  const patchCap = opts.patchCap ?? PATCH_CAP;
  // `git add -N .` (intent-to-add) makes untracked files appear in the diff, but it MUTATES the
  // index — fine in a task worktree cezar owns, but forbidden on the user's real main tree (a
  // read-only GET must never stage files, #major-index-mutation). When `intentToAdd` is false we
  // build a SCRATCH index (GIT_INDEX_FILE) seeded from HEAD + intent-to-add, so untracked files
  // still show WITHOUT touching the user's real index.
  let env: Record<string, string> | undefined;
  let scratchIndex: string | undefined;
  try {
    if (opts.intentToAdd === false) {
      scratchIndex = join(tmpdir(), `cez-scratch-index-${process.pid}-${scratchSeq++}`);
      env = { GIT_INDEX_FILE: scratchIndex };
      await git(dir, ['read-tree', 'HEAD'], env); // seed with tracked files; harmless if no HEAD
      await git(dir, ['add', '-N', '.'], env);
    } else {
      await git(dir, ['add', '-N', '.']);
    }
    // Which ref anchors this task's diff — merge-base normally, the checked-out branch's
    // pre-run state when the agent repointed the worktree onto it (#591, #751). The rule is
    // shared with `worktreeShortstat`, and it runs WITH the scratch-index `env`: picking
    // between two repointed anchors compares them with `git diff --shortstat`, and `git diff`
    // refreshes and rewrites the index it reads. On the user's real main tree that would be a
    // read-only GET writing their index, and it would measure against a different index than
    // the listing below. The ref lookups themselves ignore `GIT_INDEX_FILE`.
    const { base, repointedHead } = await resolveTaskDiffBase(
      (args) => git(dir, args, env),
      baseBranch,
      {
        taskBranch: opts.taskBranch,
        runStartedAt: opts.runStartedAt,
      },
    );

    const nameStatus = await git(dir, ['diff', '--name-status', '-z', '-M', base], env);
    if (!nameStatus.ok) return { ok: false, error: gitReason(nameStatus, 'git diff failed') };
    const numstat = await git(dir, ['diff', '--numstat', '-z', '-M', base], env);
    if (!numstat.ok) return { ok: false, error: gitReason(numstat, 'git diff failed') };
    const patchOut = await git(dir, ['diff', '--patch', '-M', '--no-color', base], env);
    if (!patchOut.ok) return { ok: false, error: gitReason(patchOut, 'git diff failed') };

    return {
      ok: true,
      changes: {
        ...assemblePayload(nameStatus.stdout, numstat.stdout, patchOut.stdout, patchCap),
        ...(repointedHead ? { repointedHead } : {}),
      },
    };
  } finally {
    if (scratchIndex) rmSync(scratchIndex, { force: true });
  }
}

/** Monotonic suffix for scratch index files, so concurrent /api/repo/changes calls never share
 *  one (each is cleaned up in the finally above). */
let scratchSeq = 0;

/** The three raw `git diff` listings (name-status, numstat, patch) → the `{files, stat}`
 *  payload. Shared by the working-tree diff above and the commit diff below. Each file's
 *  patch is matched by path (`patchByPath`), so a mismatch between the name-status and
 *  patch file counts — a typechange, submodule, or any entry that emits no `diff --git`
 *  block — drops at most that one file's patch instead of blanking every file's. Positional
 *  matching remains the fallback for a section whose path can't be parsed, but only when the
 *  counts agree (the same condition the old all-or-nothing guard required). Exported for tests. */
export function assemblePayload(
  nameStatusOut: string,
  numstatOut: string,
  patchOut: string,
  patchCap: number,
): ChangesPayload {
  const statuses = parseNameStatusZ(nameStatusOut);
  const counts = parseNumstatZ(numstatOut);
  const patches = splitPatch(patchOut);
  const countByPath = new Map(counts.map((entry) => [entry.path, entry]));
  const patchesByPath = patchByPath(patches);
  const alignable = patches.length === statuses.length;

  const files: ChangedFile[] = statuses.map((entry, idx) => {
    const count = countByPath.get(entry.path);
    let patch = patchesByPath.get(entry.path) ?? (alignable ? (patches[idx] ?? '') : '');
    if (patch.length > patchCap) patch = `${patch.slice(0, patchCap)}\n… (patch truncated)`;
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: statusWord(entry.status),
      adds: count?.adds ?? 0,
      dels: count?.dels ?? 0,
      binary: count?.binary ?? false,
      ...(imageMimeType(entry.path) ? { image: true } : {}),
      patch,
    };
  });

  return {
    files,
    stat: {
      adds: files.reduce((sum, f) => sum + f.adds, 0),
      dels: files.reduce((sum, f) => sum + f.dels, 0),
      files: files.length,
    },
  };
}

// ---- run commit log ---------------------------------------------------------

export interface RunCommit {
  sha: string;
  subject: string;
  author: string;
  /** Relative time ("3 hours ago"), git's `%cr`. */
  when: string;
}

export type RunCommitsResult = { ok: true; commits: RunCommit[] } | { ok: false; error: string };

/**
 * The commits reachable from the worktree's current HEAD after its base, newest first. A review
 * task may deliberately repoint HEAD to the reviewed branch, so this list retains that useful
 * history even though `collectChanges` narrows its payload to uncommitted work in that case.
 * Empty (not an error) when the branch has no commits past base.
 */
export async function collectRunCommits(dir: string, baseBranch: string): Promise<RunCommitsResult> {
  if (!isSafeGitRef(baseBranch)) return { ok: false, error: 'refusing option-like base ref' };
  const mergeBase = await git(dir, ['merge-base', baseBranch, 'HEAD']);
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
  const log = await git(dir, ['log', '--pretty=format:%H%x1f%s%x1f%an%x1f%cr', `${base}..HEAD`]);
  if (!log.ok) return { ok: false, error: gitReason(log, 'git log failed') };
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = '', author = '', when = ''] = line.split('\x1f');
      return { sha, subject, author, when };
    });
  return { ok: true, commits };
}

// ---- commit diffs -----------------------------------------------------------

/** `GET /api/repo/commit/:sha?structured=1` — one commit's metadata plus the same
 *  structured `{files, stat}` shape the working-tree routes serve (R5 Step 1.7). The
 *  legacy text-blob answer of that route is a protected surface and stays untouched. */
export interface CommitPayload {
  sha: string;
  subject: string;
  author: string;
  /** Relative time ("3 hours ago") — same `%cr` format the /api/repo log uses. */
  when: string;
  files: ChangedFile[];
  stat: { adds: number; dels: number; files: number };
}

export type CommitChangesResult = { ok: true; commit: CommitPayload } | { ok: false; error: string };

/**
 * Structured diff of ONE commit vs its first parent (`--root` covers the initial commit).
 * A merge commit honestly answers zero files — `git diff-tree` shows no diff for merges
 * without `-m`/`-c`, and inventing one side's diff would misattribute the changes.
 * Unknown/invalid shas degrade to `{ ok:false, error }` for the route's 409.
 */
export async function collectCommitChanges(
  dir: string,
  sha: string,
  patchCap = PATCH_CAP,
): Promise<CommitChangesResult> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return { ok: false, error: `not a commit hash: ${sha}` };

  const meta = await git(dir, ['show', '-s', '--format=%H%x1f%s%x1f%an%x1f%cr', `${sha}^{commit}`]);
  if (!meta.ok) return { ok: false, error: gitReason(meta, `unknown commit: ${sha}`) };
  const [fullSha = '', subject = '', author = '', when = ''] = meta.stdout.trim().split('\x1f');

  const common = ['diff-tree', '--no-commit-id', '--root', '-r', '-M'];
  const nameStatus = await git(dir, [...common, '--name-status', '-z', fullSha]);
  if (!nameStatus.ok) return { ok: false, error: gitReason(nameStatus, 'git diff-tree failed') };
  const numstat = await git(dir, [...common, '--numstat', '-z', fullSha]);
  if (!numstat.ok) return { ok: false, error: gitReason(numstat, 'git diff-tree failed') };
  const patchOut = await git(dir, [...common, '--patch', '--no-color', fullSha]);
  if (!patchOut.ok) return { ok: false, error: gitReason(patchOut, 'git diff-tree failed') };

  const payload = assemblePayload(nameStatus.stdout, numstat.stdout, patchOut.stdout, patchCap);
  return { ok: true, commit: { sha: fullSha, subject, author, when, ...payload } };
}

// ---- worktree file browsing ---------------------------------------------------

/** Max file content served to the Files tab — past this the GUI shows an
 *  honest "too large" state instead of the bytes. */
export const FILE_CONTENT_CAP = 512_000;

export interface DirEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

export type FilesResult =
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; path: string; size: number; binary: boolean; tooLarge: boolean; content?: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'missing'; error: string };

/**
 * Extensions the Files tab renders inline as `<img>` — the only kinds the
 * `/files?raw=1` mode will ever serve as bytes (anything else stays JSON, so a
 * worktree HTML file can never become a same-origin document). SVG is included:
 * inert inside `<img>`, and the raw response carries a no-script CSP for the
 * "opened the URL directly" case. Keep in sync with IMAGE_EXTENSIONS in
 * web/app/src/routes/task-git/file-preview.tsx.
 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** The image MIME type for a path, or null when it is not an image we serve raw. */
export function imageMimeType(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Extensions the "open in the OS default app" route (#365) will hand to the OS launcher —
 * deliberately NOT `imageMimeType`'s list, even though it is otherwise the same set minus one.
 *
 * `IMAGE_MIME` earns its SVG entry from two mitigations that belong to the HTTP response:
 * the bytes land inside an `<img>` (inert), and the raw route attaches a no-script CSP. The OS
 * launcher has neither — it just asks the OS to open the file, and the default handler for
 * `.svg` is usually a browser, which runs `<script>` inside it from a `file://` origin. A repo
 * can force an SVG down the preview branch on demand (`*.svg binary` in its own `.gitattributes`
 * makes numstat report it binary ⇒ `shouldPreviewImage`), so this is reachable, not theoretical.
 *
 * Raster only: pixels, no document. Sharing the list with the raw route would silently inherit
 * a decision that was justified by a CSP this path never applies.
 */
const OS_OPENABLE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

/** True when `path` is an image safe to hand to the OS's default handler — see OS_OPENABLE_EXT. */
export function isOsOpenableImage(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return OS_OPENABLE_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** True when the first 8 KB contain a NUL byte — good enough for a viewer flag. */
async function sniffBinary(path: string, size: number): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const len = Math.min(size, 8192);
    if (len === 0) return false;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    return buf.includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Directory listing or file content from inside `root`, traversal-safe:
 * anything resolving outside the root (dot-segments, absolute paths, NUL) is
 * rejected — same "not a file we serve" stance as `isSafeAssetFilename` in
 * src/server/static-ui.ts. `.git` and symlinks are off-limits too.
 */
export async function readWorktreePath(
  root: string,
  relPath: string,
  contentCap = FILE_CONTENT_CAP,
): Promise<FilesResult> {
  if (relPath.includes('\0')) return { kind: 'invalid', error: 'invalid path' };
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relPath);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    return { kind: 'invalid', error: `path escapes the worktree: ${relPath}` };
  }
  const gitDir = join(rootAbs, '.git');
  if (target === gitDir || target.startsWith(gitDir + sep)) {
    return { kind: 'invalid', error: '.git internals are not browsable' };
  }
  const display = target === rootAbs ? '' : target.slice(rootAbs.length + 1).split(sep).join('/');

  let info;
  try {
    info = await lstat(target);
  } catch {
    return { kind: 'missing', error: `no such file or directory in the worktree: ${relPath || '/'}` };
  }
  if (info.isSymbolicLink()) {
    return { kind: 'invalid', error: `symlinks are not served: ${display}` };
  }
  // Intermediate symlinked DIRECTORIES: `resolve()` never follows links and the `lstat` above
  // only guards the final component, so a path through a symlinked dir (e.g. `link/secret.txt`
  // where `link -> /etc`) would otherwise be served. Resolve the whole chain and re-check
  // containment against the real root (#blocker-symlink-traversal).
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = await realpath(target);
    realRoot = await realpath(rootAbs);
  } catch {
    return { kind: 'missing', error: `no such file or directory in the worktree: ${relPath || '/'}` };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return { kind: 'invalid', error: `path escapes the worktree: ${relPath}` };
  }

  if (info.isDirectory()) {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.name === '.git') continue;
      if (d.isDirectory()) {
        entries.push({ name: d.name, type: 'dir' });
      } else if (d.isFile()) {
        const size = await stat(join(target, d.name))
          .then((s) => s.size)
          .catch(() => undefined);
        entries.push({ name: d.name, type: 'file', ...(size !== undefined ? { size } : {}) });
      }
      // Symlinks, sockets, … deliberately omitted from the listing.
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { kind: 'dir', path: display, entries };
  }

  if (!info.isFile()) return { kind: 'invalid', error: `not a regular file: ${display}` };

  const binary = await sniffBinary(target, info.size).catch(() => true);
  const tooLarge = info.size > contentCap;
  if (binary || tooLarge) {
    return { kind: 'file', path: display, size: info.size, binary, tooLarge };
  }
  const content = await readFile(target, 'utf8');
  return { kind: 'file', path: display, size: info.size, binary: false, tooLarge: false, content };
}

// ---- branches -------------------------------------------------------------

export type BranchResult =
  | { ok: true; branch: string; created: boolean }
  | { ok: false; error: string };

/**
 * Repo-view branch action (`POST /api/repo/branch`): switch to `name` when it
 * already exists locally, otherwise create it from `from` (or HEAD) and switch.
 * Name validation is delegated to `git check-ref-format --branch` — git's own
 * rules, not a reimplementation — behind an explicit dash-guard (#431).
 * Predictable failures (invalid name, unknown `from`, dirty-tree checkout
 * conflict) come back as `{ ok:false, error }`.
 */
export async function createOrSwitchBranch(
  dir: string,
  name: string,
  from?: string,
): Promise<BranchResult> {
  // Dash-guard (#431): `name` reaches `git checkout <name>` / `git checkout -b <name>` as a
  // positional operand, so it gets the same explicit guard as `from` below — check-ref-format
  // already rejects option-like names, and the point is not to rely on that alone.
  if (!isSafeGitRef(name)) return { ok: false, error: `invalid branch name: ${name}` };
  const check = await git(dir, ['check-ref-format', '--branch', name]);
  if (!check.ok) return { ok: false, error: `invalid branch name: ${name}` };

  const exists = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  if (exists.ok) {
    const sw = await git(dir, ['checkout', name]);
    if (!sw.ok) return { ok: false, error: gitReason(sw, `git checkout ${name} failed`) };
    return { ok: true, branch: name, created: false };
  }

  if (from) {
    // Dash-guard (#431): `from` becomes a positional operand of `checkout -b`.
    if (!isSafeGitRef(from)) return { ok: false, error: `invalid start point: ${from}` };
    // `--quiet` keeps git silent on failure, so supply our own reason.
    const start = await git(dir, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
    if (!start.ok) return { ok: false, error: `unknown start point: ${from}` };
  }
  const create = await git(dir, from ? ['checkout', '-b', name, from] : ['checkout', '-b', name]);
  if (!create.ok) return { ok: false, error: gitReason(create, `git checkout -b ${name} failed`) };
  return { ok: true, branch: name, created: true };
}

// ---- commit & push ------------------------------------------------------------

export type CommitResult = { ok: true; sha: string } | { ok: false; error: string };

/** `git add -A && git commit -m <message>` in `dir`. A clean tree, a failing
 *  hook or missing identity all come back as `{ ok:false, error }`. */
export async function commitAll(dir: string, message: string): Promise<CommitResult> {
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.ok) return { ok: false, error: gitReason(status, 'git status failed') };
  if (!status.stdout.trim()) {
    return { ok: false, error: 'nothing to commit — the working tree is clean' };
  }
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) return { ok: false, error: gitReason(add, 'git add failed') };
  const commit = await git(dir, ['commit', '-m', message]);
  if (!commit.ok) return { ok: false, error: gitReason(commit, 'git commit failed') };
  const head = await git(dir, ['rev-parse', 'HEAD']);
  return { ok: true, sha: head.ok ? head.stdout.trim() : '' };
}

export type PushResult =
  | { ok: true; branch: string; remote: string; upstreamSet: boolean }
  | { ok: false; error: string };

/** Push the current branch, setting upstream when it has none. No remote,
 *  detached HEAD and rejected pushes all degrade to `{ ok:false, error }`. */
export async function pushCurrentBranch(dir: string): Promise<PushResult> {
  const branchRes = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branchRes.ok) return { ok: false, error: gitReason(branchRes, 'not a git repository') };
  const branch = branchRes.stdout.trim();
  if (!branch || branch === 'HEAD') {
    return { ok: false, error: 'detached HEAD — check out a branch before pushing' };
  }
  const remotesRes = await git(dir, ['remote']);
  const remotes = remotesRes.stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) {
    return { ok: false, error: 'no remote configured — add one with `git remote add origin <url>`' };
  }
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] as string);
  const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const args = upstream.ok ? ['push'] : ['push', '-u', remote, branch];
  const push = await git(dir, args);
  if (!push.ok) return { ok: false, error: gitReason(push, 'git push failed') };
  return { ok: true, branch, remote, upstreamSet: !upstream.ok };
}
