import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GLAB_NOT_FOUND_REASON } from './forge/gitlab.ts';
import { forgeKindOfHost, parseRemote } from './forge/index.ts';

/**
 * `POST /api/projects/checkout` — the "Add project → Clone from a git forge" flow
 * (spec 2026-07-20-multi-project-workspace, step 4.3; GitLab remotes added by
 * spec 2026-08-10-forge-provider-adapters, Step 4.2).
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
  /** `gh` (or `glab`, for a GitLab source) is missing — the spec's
   *  `{ error, reason }` degradation, mirroring the forge pane's contract. */
  | { ok: false; status: 503; error: string; reason: string };

export type CheckoutResult = { ok: true; target: string; name: string } | CheckoutFailure;

/** A forge repo reference the clone flow accepts. */
export interface RepoRef {
  /** Which forge — and therefore which CLI — clones it (spec
   *  2026-08-10-forge-provider-adapters, Step 4.2). */
  kind: 'github' | 'gitlab';
  /** GitHub: the owner. GitLab: the segment directly above the repo (the
   *  innermost group); the full project path is `slug`. */
  owner: string;
  /** The LAST path segment — the default checkout folder name. */
  repo: string;
  /** Normalized identity used in messages and dry-run output: `owner/repo` on
   *  GitHub, the full project path (`group/sub/repo`) on GitLab. */
  slug: string;
  /** What `gh repo clone` is handed. Always reconstructed from validated
   *  segments rather than preserving user input. Forcing HTTPS is load-bearing:
   *  a machine configured with `gh config set git_protocol ssh` may have an
   *  OAuth token authorized for an organization's SAML policy while its SSH key
   *  is not. Passing only `owner/repo` silently selects that rejected key.
   *  The resulting HTTPS `origin` needs a credential path of its own after the
   *  clone — see `persistGhCredentialHelper`. GitLab: `<web origin>/<path>.git`,
   *  rebuilt from the parsed remote so credentials in the input never survive —
   *  its origin needs the same credential path after the clone, see
   *  `persistGlabCredentialHelper` / `gitlabCloneOrigin`. */
  cloneUrl: string;
}

/** `owner` and `repo` as GitHub itself allows them: alphanumerics, `-`, `_`,
 *  `.`. Deliberately strict — this string becomes a `gh` argv entry and half of
 *  a filesystem path, and every character outside this set is someone trying
 *  something. */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A GitLab project path is `group[/subgroup…]/repo`; GitLab itself caps
 *  nesting at 20 levels, so anything deeper is not a real project. */
const MAX_GITLAB_PATH_SEGMENTS = 21;

/**
 * Parse `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`
 * or `github.com/owner/repo` into a normalized GitHub ref — or a full https /
 * ssh / scp URL on a host classified `gitlab` (`forgeKindOfHost`: gitlab.com or
 * a discovered on-prem instance) into a GitLab ref, subgroups allowed. `null`
 * when it is neither — the route answers 400 rather than handing an arbitrary
 * string to a CLI.
 *
 * GitHub means github.com only: `gh repo clone` would happily take an
 * enterprise host, but this flow's contract (and its `gh`-availability
 * degradation) is github.com's, and silently accepting `evil.example/owner/repo`
 * would make the "which host am I cloning from" question unanswerable from the
 * dialog. A GitLab source must be a full URL for the same reason — the host is
 * always spelled out, never guessed, and a bare `owner/repo` stays GitHub.
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
    // Not a github.com spelling: a URL naming a GitLab host, or nothing.
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^[^/]+:/.test(path)) return parseGitlabRef(path);
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo || !NAME_SEGMENT.test(owner) || !NAME_SEGMENT.test(repo)) return null;
  return {
    kind: 'github',
    owner,
    repo,
    slug: `${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/** The GitLab half of `parseRepoRef`: a full URL whose host classifies as
 *  `gitlab`. Every path segment passes the same `NAME_SEGMENT` check the GitHub
 *  shape does, and the clone URL is rebuilt from the parsed origin + validated
 *  segments — user info, query strings and odd characters never reach `glab`.
 *  The host needs no check of its own: `parseRemote` returns null unless it is a
 *  hostname, and `forgeKindOfHost` then matches it against a known set. */
function parseGitlabRef(url: string): RepoRef | null {
  const remote = parseRemote(url);
  if (!remote || forgeKindOfHost(remote.host) !== 'gitlab') return null;
  const parts = remote.path.split('/');
  if (parts.length < 2 || parts.length > MAX_GITLAB_PATH_SEGMENTS) return null;
  if (!parts.every((part) => NAME_SEGMENT.test(part))) return null;
  const repo = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!repo || !owner) return null;
  const slug = parts.join('/');
  return { kind: 'gitlab', owner, repo, slug, cloneUrl: `${remote.origin}/${slug}.git` };
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

/** Kept pure so the SAML-safe transport choice is pinned without spawning a
 * real GitHub process in the unit suite. */
export function ghCloneArgs(ref: RepoRef, dir: string): string[] {
  return ['repo', 'clone', ref.cloneUrl, dir, '--', '--progress'];
}

/** PR #968: gh injects credentials only for the clone command. Persist the
 * helper locally so subsequent raw git pushes (including task worktrees) use
 * the same OAuth grant. Reset inherited helpers first, as gh setup-git does. */
async function persistGhCredentialHelper(dir: string): Promise<boolean> {
  for (const args of [
    ['--replace-all', 'credential.https://github.com.helper', ''],
    ['--add', 'credential.https://github.com.helper', '!gh auth git-credential'],
  ]) {
    const ok = await new Promise<boolean>((resolvePromise) => {
      execFile('git', ['-C', dir, 'config', '--local', ...args],
        { timeout: 10_000 }, (err) => resolvePromise(!err));
    });
    if (!ok) return false;
  }
  return true;
}

type CloneOutcome = Awaited<ReturnType<CloneRunner>>;

/**
 * Spawn one forge CLI clone (`gh`/`glab`) and stream its progress — the shared
 * body of `ghCloneRunner` and `glabCloneRunner`. `afterSuccess` runs on exit
 * code 0 and decides the final outcome (GitHub persists its credential helper
 * there); `exitLabel` names the command in the no-output failure message.
 *
 * `spawn`, not `execFile`, because the whole point of this route is that the
 * dialog sees progress while it happens: `git clone --progress` writes its
 * counters to stderr, and each line becomes a `checkout-progress` event.
 * (`--progress` is needed explicitly — git suppresses it when stderr is not a
 * TTY, which it never is here.)
 */
function spawnClone(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  exitLabel: string,
  afterSuccess: () => Promise<CloneOutcome>,
  onLine: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<CloneOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLONE_TIMEOUT_MS,
      env,
    });
    const tail: string[] = [];
    let settled = false;
    const finish = (result: CloneOutcome): void => {
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
      // ENOENT is the CLI-not-installed case, which the route degrades on
      // rather than reports as a clone failure.
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
      finish({ ok: false, error: err.message, notFound });
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        void afterSuccess().then(finish);
        return;
      }
      // The tail of the CLI's / git's own output IS the error message — `gh`
      // and `glab` write "could not find repository", "authentication required"
      // and the network errors themselves, and paraphrasing them would only
      // lose detail.
      const detail = tail.join('\n').trim();
      finish({ ok: false, error: detail === '' ? `${exitLabel} exited with code ${code}` : detail });
    });
  });
}

/** `gh repo clone <validated HTTPS URL> <dir> -- --progress`, then the
 *  persisted credential helper (PR #968). */
export const ghCloneRunner: CloneRunner = (ref, dir, onLine, signal) =>
  spawnClone(
    'gh',
    ghCloneArgs(ref, dir),
    // No inherited stdin and `GH_PROMPT_DISABLED`: an unauthenticated `gh`
    // must fail with a message the dialog can show, not block on a prompt
    // nobody can see.
    { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    'gh repo clone',
    async () => (await persistGhCredentialHelper(dir))
      ? { ok: true }
      : { ok: false, error: 'Could not configure GitHub credentials for the checkout. Check directory permissions and retry.' },
    onLine,
    signal,
  );

/** glab's git credential helper (glab 1.118 provides `glab auth git-credential`, the twin of
 *  `gh auth git-credential`). */
const GLAB_CREDENTIAL_HELPER = '!glab auth git-credential';

/** Kept pure like `ghCloneArgs`: `glab repo clone <rebuilt URL> <dir> -- --progress -c …`
 *  (spec 2026-08-10-forge-provider-adapters, Step 4.2). The full URL, not the
 *  bare path, so an on-prem instance is cloned from the host the dialog showed
 *  rather than whatever `GITLAB_HOST` / glab's default host happens to be.
 *
 *  Unlike `gh`, `glab repo clone` handed a full HTTPS URL does NOT authenticate the clone: it runs
 *  a bare `git clone`, so a private project failed with "could not read Username" (verified live
 *  against gitlab.com, glab 1.118). The credential helper therefore rides
 *  along as `git clone -c` flags — git applies them BEFORE fetching and writes them into the new
 *  repo's config. Throws on a non-http(s) `cloneUrl` (`gitlabCloneOrigin`). */
export function glabCloneArgs(ref: RepoRef, dir: string): string[] {
  const key = `credential.${gitlabCloneOrigin(ref)}.helper`;
  return ['repo', 'clone', ref.cloneUrl, dir, '--', '--progress', '-c', `${key}=`, '-c', `${key}=${GLAB_CREDENTIAL_HELPER}`];
}

/** GitLab twin of `persistGhCredentialHelper` (4.2-review-fix): re-asserts the helper the clone's
 *  `-c` flags already wrote (`glabCloneArgs`), so a task worktree's first raw `git push` against an
 *  HTTPS GitLab remote authenticates through `glab` even if the clone left no helper behind. Keyed
 *  on the clone's own origin — never a hardcoded host — because a GitLab source can be gitlab.com
 *  or any discovered on-prem instance, each needing its own `credential.<origin>.helper` entry. */
async function persistGlabCredentialHelper(dir: string, origin: string): Promise<boolean> {
  for (const args of [
    ['--replace-all', `credential.${origin}.helper`, ''],
    ['--add', `credential.${origin}.helper`, GLAB_CREDENTIAL_HELPER],
  ]) {
    const ok = await new Promise<boolean>((resolvePromise) => {
      execFile('git', ['-C', dir, 'config', '--local', ...args],
        { timeout: 10_000 }, (err) => resolvePromise(!err));
    });
    if (!ok) return false;
  }
  return true;
}

/** The origin `credential.<origin>.helper` is keyed on, recovered from
 *  `cloneUrl` rather than threaded through as a separate field: `parseGitlabRef`
 *  always rebuilds `cloneUrl` as `${origin}/${slug}.git` (the parsed remote's web
 *  origin, D3 — always `http(s)://host[:port]`, never a path), so `new URL(...)
 *  .origin` recovers it exactly. Guarded rather than assumed: if that invariant
 *  ever breaks, the clone must fail loudly instead of keying a credential helper
 *  against the wrong (or an unparsable) origin. */
function gitlabCloneOrigin(ref: RepoRef): string {
  const url = new URL(ref.cloneUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`glab clone URL is not http(s): ${ref.cloneUrl}`);
  }
  return url.origin;
}

/** `glab repo clone` — the GitLab twin of `ghCloneRunner`, same streaming,
 *  cancellation and ENOENT degradation, plus its own persisted credential
 *  helper (4.2-review-fix) so later task-worktree pushes authenticate through
 *  `glab`. `GLAB_NO_PROMPT` is glab's `GH_PROMPT_DISABLED`; glab 1.118 deprecated
 *  the older `NO_PROMPT` spelling with a warning line that led every clone error,
 *  and it stays set for glab releases that predate the rename. */
export const glabCloneRunner: CloneRunner = async (ref, dir, onLine, signal) => {
  let origin: string;
  let args: string[];
  try {
    origin = gitlabCloneOrigin(ref);
    args = glabCloneArgs(ref, dir);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  return spawnClone(
    'glab',
    args,
    { ...process.env, GLAB_NO_PROMPT: '1', NO_PROMPT: '1', GIT_TERMINAL_PROMPT: '0' },
    'glab repo clone',
    async () => (await persistGlabCredentialHelper(dir, origin))
      ? { ok: true }
      : { ok: false, error: 'Could not configure GitLab credentials for the checkout. Check directory permissions and retry.' },
    onLine,
    signal,
  );
};

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
  /** Raw user input: `owner/repo`, a GitHub URL, or a GitLab URL. */
  url: string;
  /** Target folder name; defaults to the repo name. */
  name?: string | undefined;
  /** The checkout root, ALREADY `~`-expanded by the caller. */
  projectsDir: string;
  onProgress: (event: CheckoutProgressEvent) => void;
  checkoutId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam; defaults to `gh` / `glab` by the ref's kind (or the dry-run
   *  fake under `CEZ_DRY_RUN=1`). */
  run?: CloneRunner;
}

/**
 * Clone a GitHub or GitLab repo into `<projectsDir>/<name>`, streaming progress.
 *
 * Answers only when the clone has finished (the spec's "long-running: answers
 * when the clone finishes"); the dialog's liveness comes from `onProgress`.
 * On any failure the partially-written directory is removed and NOTHING is
 * registered — registration is the caller's job, and only on `ok: true`.
 */
export async function checkoutRepo(opts: CheckoutOptions): Promise<CheckoutResult> {
  const ref = parseRepoRef(opts.url);
  if (!ref) {
    return { ok: false, status: 400, error: `not a git forge repository: ${opts.url.trim().slice(0, 200)}` };
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

  const run = opts.run
    ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCloneRunner : ref.kind === 'gitlab' ? glabCloneRunner : ghCloneRunner);
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
      // The GitLab wording is the driver's own constant, not a copy: one string, so a reason the
      // cockpit matches on cannot drift between the checkout flow and every other GitLab route.
      const reason = ref.kind === 'gitlab'
        ? GLAB_NOT_FOUND_REASON
        : 'gh CLI not found — install it and run `gh auth login`';
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
