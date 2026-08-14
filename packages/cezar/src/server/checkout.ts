import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * `POST /api/projects/checkout` — the "Add project → Clone from GitHub" flow
 * (spec 2026-07-20-multi-project-workspace, step 4.3).
 *
 * The route itself (server.ts) owns the registry write; this module owns the
 * only two things that are genuinely dangerous about cloning on the operator's
 * behalf:
 *
 * 1. **Where the clone lands.** The target is always `<projectsDir>/<name>`
 *    with `name` a single, boring path segment. It is never a nested path,
 *    never `..`, never absolute — the checkout root is a root, not a starting
 *    point for traversal.
 * 2. **What cleanup may delete.** A failed clone must not leave a half-written
 *    directory behind (a later attempt would trip over it, and registering it
 *    would put a broken project in the sidebar). But "rm -rf the target" is a
 *    destructive path reached by a *network failure*, so it is guarded as
 *    tightly as `fs-browse.ts` guards containment — see `cleanupCheckout`.
 *
 * The load-bearing trick for (2) is that the target directory is created HERE,
 * with a non-recursive `mkdir`, before `gh` ever runs. That single syscall is
 * both the atomic existence check (EEXIST ⇒ 409, and we never touched what was
 * there) and the proof of ownership that authorizes cleanup: we only ever
 * delete a directory this operation is known to have created.
 */

/** How long a clone may run before it is killed. Long enough for a large repo
 *  on a slow link, short enough that a hung `gh` (an auth prompt that will
 *  never be answered — `gh` is non-interactive here, but a proxy can still
 *  stall) does not pin a request forever. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Progress lines kept for the error message. `git clone` is chatty and the
 *  useful part of a failure is always at the end. */
const ERROR_TAIL_LINES = 6;

/** One `checkout-progress` SSE payload (workspace-level event, step 2.8's bus).
 *  `checkoutId` is echoed from the request so a cockpit only renders its own
 *  clone — two tabs cloning at once share the one workspace stream. */
export interface CheckoutProgressEvent {
  checkoutId?: string;
  /** The target folder name, so a payload is readable without the id too. */
  name: string;
  phase: 'cloning' | 'done' | 'error';
  /** One line of `git clone` progress (present on `cloning`). */
  line?: string;
  /** Human-readable failure (present on `error`). */
  error?: string;
}

export type CheckoutFailure =
  | { ok: false; status: 400 | 409 | 500; error: string }
  /** `gh` is missing or unauthenticated — the spec's `{ error, reason }`
   *  degradation, mirroring the GitHub pane's contract. */
  | { ok: false; status: 503; error: string; reason: string };

export type CheckoutResult = { ok: true; target: string; name: string } | CheckoutFailure;

/** A GitHub repo reference the clone flow accepts. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** What `gh repo clone` is handed — always the normalized `owner/repo`, so a
   *  URL spelling can never smuggle flags or a different host past `gh`. */
  slug: string;
}

/** `owner` and `repo` as GitHub itself allows them: alphanumerics, `-`, `_`,
 *  `.`. Deliberately strict — this string becomes a `gh` argv entry and half of
 *  a filesystem path, and every character outside this set is someone trying
 *  something. */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`
 * or `github.com/owner/repo` into a normalized ref. `null` when it is not a
 * GitHub repo reference — the route answers 400 rather than handing an
 * arbitrary string to `gh`.
 *
 * Only github.com: `gh repo clone` would happily take an enterprise host, but
 * this flow's contract (and its `gh`-availability degradation) is GitHub's, and
 * silently accepting `evil.example/owner/repo` would make the "which host am I
 * cloning from" question unanswerable from the dialog.
 */
export function parseRepoRef(input: string): RepoRef | null {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > 512) return null;
  // Strip the scheme/host spellings down to `owner/repo`, then validate ONE
  // shape. Doing it the other way round (a regex per spelling) is how a fourth
  // spelling eventually gets a weaker check than the other three.
  let path = trimmed;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/.exec(path);
  if (ssh?.[1]) path = ssh[1];
  else {
    const https = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/.exec(path);
    if (https?.[1]) path = https[1];
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo || !NAME_SEGMENT.test(owner) || !NAME_SEGMENT.test(repo)) return null;
  return { owner, repo, slug: `${owner}/${repo}` };
}

/**
 * Validate the target folder name (the dialog lets the user edit it, and it
 * defaults to the repo name).
 *
 * A name is one path segment and nothing else. `.` / `..` and anything with a
 * separator are rejected outright rather than sanitized: a silently rewritten
 * name would clone somewhere other than the path the dialog previewed, which
 * is the one thing a checkout target must never do. A leading dot is refused
 * too — a project named `.ssh` under the checkout root is not a project.
 */
export function isValidCheckoutName(name: string): boolean {
  return name.length <= 128 && NAME_SEGMENT.test(name) && !name.includes('/') && !name.includes('\\');
}

/**
 * Delete a partially-cloned checkout — the ONE destructive path in this module.
 *
 * Called only after `mkdir(target)` (non-recursive, so it succeeded only
 * because the directory did not exist and WE created it). Even with that proof
 * in hand, every one of these must hold or nothing is deleted:
 *
 * - `target` is still a real directory and NOT a symlink (`lstat`, not `stat`):
 *   between the mkdir and the failure, the directory could have been swapped
 *   for a link pointing anywhere.
 * - `projectsDir` and `target` both resolve (`realpath`), and the resolved
 *   target's PARENT is exactly the resolved checkout root. That is strict
 *   containment (nothing outside the root) *and* a depth limit (a direct child
 *   only, never the root itself, never a nested path).
 *
 * Any surprise — a vanished path, an unresolvable root, a `rm` that fails —
 * leaves the directory alone. Leaving a stray folder is a nuisance; deleting
 * the wrong one is unrecoverable, so every ambiguous case resolves toward "do
 * nothing".
 */
export async function cleanupCheckout(projectsDir: string, target: string): Promise<boolean> {
  let realRoot: string;
  let realTarget: string;
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    realRoot = await realpath(projectsDir);
    realTarget = await realpath(target);
  } catch {
    return false; // gone, or unresolvable — either way, not ours to remove
  }
  if (realTarget === realRoot) return false;
  if (dirname(realTarget) !== realRoot) return false;
  try {
    await rm(realTarget, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Injected so the tests can drive a fake clone without a network or a `gh`
 *  binary. `dir` already exists (we created it); the runner clones INTO it. */
export type CloneRunner = (
  ref: RepoRef,
  dir: string,
  onLine: (line: string) => void,
  signal: AbortSignal | undefined,
) => Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }>;

/**
 * `gh repo clone <owner/repo> <dir> -- --progress`.
 *
 * `spawn`, not `execFile`, because the whole point of this route is that the
 * dialog sees progress while it happens: `git clone --progress` writes its
 * counters to stderr, and each line becomes a `checkout-progress` event.
 * (`--progress` is needed explicitly — git suppresses it when stderr is not a
 * TTY, which it never is here.)
 */
export const ghCloneRunner: CloneRunner = (ref, dir, onLine, signal) =>
  new Promise((resolvePromise) => {
    const child = spawn('gh', ['repo', 'clone', ref.slug, dir, '--', '--progress'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLONE_TIMEOUT_MS,
      // No inherited stdin and `GH_PROMPT_DISABLED`: an unauthenticated `gh`
      // must fail with a message the dialog can show, not block on a prompt
      // nobody can see.
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    const tail: string[] = [];
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; error: string; notFound?: boolean }): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    // The client hung up (dialog closed, tab gone). Kill the clone rather than
    // let it keep writing into a directory nobody is waiting for — the caller
    // then takes the failure path, which cleans up.
    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'checkout cancelled' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // git's progress is carriage-return-separated, not newline-separated —
    // splitting on `\n` alone would buffer the whole "Receiving objects" phase
    // into one line delivered at the end, which is exactly the silent spinner
    // this stream exists to avoid.
    let pending = '';
    const consume = (chunk: string): void => {
      pending += chunk;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (line === '') continue;
        tail.push(line);
        if (tail.length > ERROR_TAIL_LINES) tail.shift();
        onLine(line);
      }
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', consume);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', consume);

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      // ENOENT is the `gh`-not-installed case, which the route degrades on
      // rather than reports as a clone failure.
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
      finish({ ok: false, error: err.message, notFound });
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) return finish({ ok: true });
      // The tail of gh/git's own output IS the error message — `gh` writes
      // "could not find repository", "authentication required" and the network
      // errors itself, and paraphrasing them would only lose detail.
      const detail = tail.join('\n').trim();
      finish({ ok: false, error: detail === '' ? `gh repo clone exited with code ${code}` : detail });
    });
  });

/** `CEZ_DRY_RUN=1` — a fake clone so the dialog (and the tests) can exercise
 *  the whole flow offline: a few progress lines and a plausible repo on disk.
 *  It writes only INSIDE the directory the caller already created. */
export const dryRunCloneRunner: CloneRunner = async (ref, dir, onLine) => {
  onLine(`Cloning into '${dir}'...`);
  onLine('remote: Enumerating objects: 3, done.');
  // A `.git` directory so the registered project probes as a git repo the way
  // a real clone would — the point of the dry run is the same shape, not the
  // same bytes.
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, 'README.md'), `# ${ref.repo}\n\n(CEZ_DRY_RUN=1 fake clone)\n`, 'utf8');
  onLine('Receiving objects: 100% (3/3), done.');
  return { ok: true };
};

export interface CheckoutOptions {
  /** Raw user input: `owner/repo` or a GitHub URL. */
  url: string;
  /** Target folder name; defaults to the repo name. */
  name?: string | undefined;
  /** The checkout root, ALREADY `~`-expanded by the caller. */
  projectsDir: string;
  onProgress: (event: CheckoutProgressEvent) => void;
  checkoutId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam; defaults to `gh` (or the dry-run fake under `CEZ_DRY_RUN=1`). */
  run?: CloneRunner;
}

/**
 * Clone a GitHub repo into `<projectsDir>/<name>`, streaming progress.
 *
 * Answers only when the clone has finished (the spec's "long-running: answers
 * when the clone finishes"); the dialog's liveness comes from `onProgress`.
 * On any failure the partially-written directory is removed and NOTHING is
 * registered — registration is the caller's job, and only on `ok: true`.
 */
export async function checkoutRepo(opts: CheckoutOptions): Promise<CheckoutResult> {
  const ref = parseRepoRef(opts.url);
  if (!ref) {
    return { ok: false, status: 400, error: `not a GitHub repository: ${opts.url.trim().slice(0, 200)}` };
  }
  const name = (opts.name ?? '').trim() === '' ? ref.repo : (opts.name ?? '').trim();
  if (!isValidCheckoutName(name)) {
    return { ok: false, status: 400, error: `not a valid folder name: ${name.slice(0, 200)}` };
  }
  if (!opts.projectsDir.startsWith('/')) {
    return { ok: false, status: 500, error: `checkout root is not an absolute path: ${opts.projectsDir}` };
  }
  const root = resolve(opts.projectsDir);
  const target = join(root, name);

  // The checkout root is created on demand — a fresh install has never had one,
  // and failing "clone" because a directory the user never asked about is
  // missing would be an odd first experience. Its writability is validated on
  // `PUT /api/workspace/config`; a failure here is reported as one.
  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    return { ok: false, status: 500, error: `checkout root is not writable: ${errText(err)}` };
  }

  // THE ownership token (see the module docstring): non-recursive, so it
  // succeeds only when it created the directory itself. EEXIST is the spec's
  // 409 — and note nothing has touched the existing directory to learn that.
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, status: 409, error: `folder already exists: ${target}` };
    }
    return { ok: false, status: 500, error: `could not create ${target}: ${errText(err)}` };
  }

  const emit = (event: Omit<CheckoutProgressEvent, 'name' | 'checkoutId'>): void =>
    opts.onProgress({ ...event, name, ...(opts.checkoutId ? { checkoutId: opts.checkoutId } : {}) });

  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCloneRunner : ghCloneRunner);
  let outcome: Awaited<ReturnType<CloneRunner>>;
  try {
    outcome = await run(ref, target, (line) => emit({ phase: 'cloning', line }), opts.signal);
  } catch (err) {
    // A runner that throws is still a failed clone — same cleanup, same shape.
    outcome = { ok: false, error: errText(err) };
  }

  if (!outcome.ok) {
    // Cleanup FIRST, then answer: the dialog's "try again" must not race a
    // directory that is still on disk (it would get the 409 instead).
    await cleanupCheckout(root, target);
    if (outcome.notFound) {
      const reason = 'gh CLI not found — install it and run `gh auth login`';
      emit({ phase: 'error', error: reason });
      return { ok: false, status: 503, error: reason, reason };
    }
    emit({ phase: 'error', error: outcome.error });
    return { ok: false, status: 500, error: outcome.error };
  }

  emit({ phase: 'done' });
  return { ok: true, target, name };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
