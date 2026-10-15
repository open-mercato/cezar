import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isAbsolutePath } from '../paths.ts';

/**
 * `POST /api/projects/checkout` — the "Add project → Clone" flow (GitHub and
 * GitLab)
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

/** Which forge a reference names. The clone mechanism differs per forge. */
export type RepoForge = 'github' | 'gitlab';

/** A repo reference the clone flow accepts. */
export interface RepoRef {
  /** GitHub's owner, or GitLab's full namespace (`group` or `group/subgroup`). */
  owner: string;
  repo: string;
  /** The normalized `<namespace>/<repo>`, so a URL spelling can never smuggle
   *  flags or a different host past the clone command. */
  slug: string;
  /** `github` clones through `gh`; `gitlab` through `glab`, falling back to `git`. */
  forge: RepoForge;
  /** The HTTPS URL the clone is handed, for BOTH forges. Always reconstructed
   *  from validated segments rather than preserving user input. For GitHub,
   *  forcing HTTPS is load-bearing: a machine configured with
   *  `gh config set git_protocol ssh` may have an OAuth token authorized for an
   *  organization's SAML policy while its SSH key is not, and passing only
   *  `owner/repo` silently selects that rejected key. The resulting HTTPS
   *  `origin` needs a credential path of its own after the clone — see
   *  `persistGhCredentialHelper`. For GitLab it is what `git` needs, since
   *  there is no `gh` to resolve a slug — unless the user typed an SSH address
   *  (see `transport`). */
  cloneUrl: string;
  /**
   * `ssh` when the user typed a GitLab SSH address (`git@gitlab.com:group/repo.git`),
   * and the clone then goes over SSH. That spelling is a statement about how this
   * machine authenticates: a private GitLab project cloned that way in a terminal
   * failed here with "could not read Username for 'https://gitlab.com'", because
   * the address had been rewritten to HTTPS, where this machine has no credential.
   * GitHub never does this — its HTTPS is load-bearing (above) and `gh` carries
   * the token.
   */
  transport: 'https' | 'ssh';
}

/** A path segment as GitHub and GitLab both allow them: alphanumerics, `-`,
 *  `_`, `.`. Deliberately strict — this string becomes a clone-command argv
 *  entry and half of a filesystem path, and every character outside this set is
 *  someone trying something. */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** GitLab nests groups, so a project path may carry subgroups. This is the
 *  documented ceiling (a project sits at most 20 levels deep) and a guard: the
 *  path becomes a URL and half a filesystem path. */
const MAX_GITLAB_DEPTH = 20;

/**
 * Parse a repo reference for a forge cezar can clone from, or `null` — the
 * route answers 400 rather than handing an arbitrary string to a clone command.
 *
 * Accepted spellings, per forge:
 *  - **GitHub** — `owner/repo`, `github.com/owner/repo`,
 *    `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`
 *  - **GitLab** — the same four with `gitlab.com`, and additionally NESTED
 *    namespaces (`group/subgroup/project`), which GitHub has no equivalent of
 *    and which a two-segment check silently rejects.
 *
 * A bare `owner/repo` with no host stays GitHub, so every existing caller and
 * saved value keeps its meaning; naming a forge requires naming its host.
 *
 * Only the two public hosts. Self-hosted GitLab is deliberately out: the
 * instance URL is unbounded input, and "which host am I cloning from" must stay
 * answerable from the dialog.
 */
export function parseRepoRef(input: string): RepoRef | null {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > 512) return null;

  // Strip the scheme/host spellings down to a bare path, remembering which
  // forge said so. Doing it this way — rather than a regex per spelling per
  // forge — is what keeps every spelling under the SAME validation below.
  let path = trimmed;
  let forge: RepoForge = 'github';
  const hosts: Array<{ forge: RepoForge; host: string }> = [
    { forge: 'github', host: 'github\\.com' },
    { forge: 'gitlab', host: 'gitlab\\.com' },
  ];
  let typedSsh = false;
  for (const candidate of hosts) {
    const ssh = new RegExp(`^(?:ssh://)?git@${candidate.host}[:/](.+)$`).exec(path);
    if (ssh?.[1]) { path = ssh[1]; forge = candidate.forge; typedSsh = true; break; }
    const https = new RegExp(`^(?:https?://)?(?:www\\.)?${candidate.host}/(.+)$`).exec(path);
    if (https?.[1]) { path = https[1]; forge = candidate.forge; break; }
  }

  path = path.replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = path.split('/');
  // GitHub is exactly owner/repo. GitLab allows subgroups between the two.
  const maxParts = forge === 'gitlab' ? MAX_GITLAB_DEPTH : 2;
  if (parts.length < 2 || parts.length > maxParts) return null;
  if (!parts.every((segment) => segment && NAME_SEGMENT.test(segment))) return null;

  const repo = parts[parts.length - 1] as string;
  const owner = parts.slice(0, -1).join('/');
  const slug = `${owner}/${repo}`;
  if (forge === 'gitlab' && typedSsh) {
    // The URL is rebuilt from the validated segments like every other spelling,
    // so an SSH address can no more smuggle an option or a host than HTTPS can.
    return { owner, repo, slug, forge, transport: 'ssh', cloneUrl: `git@gitlab.com:${slug}.git` };
  }
  return forge === 'gitlab'
    // HTTPS by default: it works for a public project with no key set up, and
    // for a private one through glab, a credential helper, or a token. Someone
    // whose GitLab login IS an ssh key says so by typing the ssh address.
    ? { owner, repo, slug, forge, transport: 'https', cloneUrl: `https://gitlab.com/${slug}.git` }
    : { owner, repo, slug, forge, transport: 'https', cloneUrl: `https://github.com/${slug}.git` };
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

/** PR #968: the `git config --local` argument lists that route github.com HTTPS
 *  credentials through `gh`. Reset inherited helpers first, as gh setup-git does.
 *  Shared with the new-project flow (`create-project.ts`). */
export const GH_CREDENTIAL_HELPER_CONFIG: readonly (readonly string[])[] = [
  ['--replace-all', 'credential.https://github.com.helper', ''],
  ['--add', 'credential.https://github.com.helper', '!gh auth git-credential'],
];

/** PR #968: gh injects credentials only for the clone command. Persist the
 * helper locally so subsequent raw git pushes (including task worktrees) use
 * the same OAuth grant. */
async function persistGhCredentialHelper(dir: string): Promise<boolean> {
  for (const args of GH_CREDENTIAL_HELPER_CONFIG) {
    const ok = await new Promise<boolean>((resolvePromise) => {
      execFile('git', ['-C', dir, 'config', '--local', ...args],
        { timeout: 10_000 }, (err) => resolvePromise(!err));
    });
    if (!ok) return false;
  }
  return true;
}

/** What a spawned clone reports back, shared by every forge's runner. */
type CloneOutcome = { ok: true } | { ok: false; error: string; notFound?: boolean };

/**
 * Run one clone command, streaming its progress.
 *
 * `spawn`, not `execFile`, because the whole point of this route is that the
 * dialog sees progress while it happens: `git clone --progress` writes its
 * counters to stderr, and each line becomes a `checkout-progress` event.
 * (`--progress` is needed explicitly — git suppresses it when stderr is not a
 * TTY, which it never is here.)
 *
 * Every forge shares this body and differs only in argv, so a fix to the
 * progress parsing or the abort path cannot land for one forge and miss another.
 */
/**
 * The ssh command for a clone nobody can answer a prompt for.
 *
 * `GIT_TERMINAL_PROMPT=0` silences git, not ssh: a passphrase-protected key with
 * no agent, or a host key never seen, makes ssh wait on a terminal the dialog
 * does not have — until the clone timeout. `BatchMode` makes it fail with its
 * own words instead. EXTENDS an exported `GIT_SSH_COMMAND` (one that names a
 * key is how that machine authenticates at all), the same rule
 * `nonInteractiveSsh` in git-worktree.ts follows for fetches.
 */
export function nonInteractiveSsh(env: NodeJS.ProcessEnv = process.env, configured = ''): Record<string, string> {
  // git's precedence: GIT_SSH_COMMAND, then `core.sshCommand` (global, for a clone), then GIT_SSH
  // — a bare program with nowhere to put options, so it is left alone rather than overridden.
  const own = env.GIT_SSH_COMMAND?.trim() || configured.trim();
  if (!own && env.GIT_SSH) return {};
  return { GIT_SSH_COMMAND: `${own || 'ssh'} -o BatchMode=yes -o ConnectTimeout=15` };
}

/** The operator's global `core.sshCommand` — a clone has no repo config yet. Empty when unset. */
function globalSshCommand(): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile('git', ['config', '--global', '--get', 'core.sshCommand'], { timeout: 5_000 }, (err, stdout) =>
      resolvePromise(err ? '' : String(stdout).trim()));
  });
}

function spawnClone(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  signal: AbortSignal | undefined,
  extraEnv: Record<string, string> = {},
): Promise<CloneOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLONE_TIMEOUT_MS,
      // No inherited stdin, and prompts disabled for both CLIs: an
      // unauthenticated `gh`/`glab`, or a private repo `git` wants a password
      // for, must fail with a message the dialog can show rather than block on a
      // prompt nobody can see.
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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
      // ENOENT is the CLI-not-installed case, which the caller degrades on
      // rather than reports as a clone failure.
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
      finish({ ok: false, error: err.message, notFound });
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) return finish({ ok: true });
      // The tail of the CLI's own output IS the error message — gh, glab and
      // git write "could not find repository", "authentication required" and
      // the network errors themselves, and paraphrasing them would only lose
      // detail.
      const detail = tail.join('\n').trim();
      finish({ ok: false, error: detail === '' ? `${command} exited with code ${code}` : detail });
    });
  });
}

/** `gh repo clone <owner/repo> <dir> -- --progress`. */
export const ghCloneRunner: CloneRunner = async (ref, dir, onLine, signal) => {
  const outcome = await spawnClone('gh', ghCloneArgs(ref, dir), onLine, signal);
  if (!outcome.ok) return outcome;
  // PR #968: gh injects credentials for the clone only. Without a persisted
  // helper, the HTTPS origin the SAML-safe clone produced cannot be pushed to.
  return (await persistGhCredentialHelper(dir))
    ? outcome
    : { ok: false, error: 'Could not configure GitHub credentials for the checkout. Check directory permissions and retry.' };
};

/**
 * GitLab: `glab repo clone` when the GitLab CLI is there, plain `git clone`
 * otherwise.
 *
 * The fallback is what makes this work with no setup — a public project clones
 * over HTTPS with nothing installed but git. `glab` is preferred when present
 * because it carries the operator's GitLab token the way `gh` does, which is the
 * only way a PRIVATE project clones without a credential helper already
 * configured; most GitLab projects are private, so trying it first is the
 * difference between "works" and "asks for a password nobody can type".
 *
 * The probe is the spawn itself: ENOENT from `glab` means not installed, and it
 * arrives before any output, so falling through costs nothing and cannot
 * half-write the directory. A glab that IS installed but unauthenticated fails
 * with its own message, which is more useful than git's.
 */
export const gitlabCloneRunner: CloneRunner = async (ref, dir, onLine, signal) => {
  const url = ref.cloneUrl ?? `https://gitlab.com/${ref.slug}.git`;
  // An ssh address goes straight to git: glab picks its own protocol from its
  // config, and the user just told us which one works here.
  if (ref.transport === 'ssh') {
    const viaSsh = await spawnClone(
      'git', ['clone', '--progress', url, dir], onLine, signal,
      nonInteractiveSsh(process.env, await globalSshCommand()),
    );
    if (viaSsh.ok || signal?.aborted || !SSH_UNUSABLE.test(viaSsh.error)) return viaSsh;
    // ssh itself could not be used — no key, an unknown host key — which is
    // the case HTTPS exists for: a public project clones with nothing set up.
    // git cleans out a failed clone, so the directory is empty again for it.
    onLine('ssh could not authenticate to gitlab.com — trying HTTPS instead');
    const viaHttps = await cloneGitlabOverHttps({ ...ref, cloneUrl: `https://gitlab.com/${ref.slug}.git` }, dir, onLine, signal);
    // Both failed: the ssh reason is the one that matches what the user typed.
    return viaHttps.ok ? viaHttps : viaSsh;
  }
  return cloneGitlabOverHttps(ref, dir, onLine, signal);
};

/** ssh failed before GitLab could say anything about the project itself. */
const SSH_UNUSABLE = /Permission denied \(publickey|Host key verification failed|no such identity|Connection timed out|Could not resolve hostname/i;

/**
 * `glab repo clone` gets the full HTTPS URL, never the bare slug — the same
 * rule as `ghCloneArgs`. A slug is resolved against glab's configured DEFAULT
 * host, so on a machine logged in to a company GitLab, `gitlab.com/acme/app`
 * pasted into the dialog would clone `acme/app` from the company instance: a
 * different repository, or a confusing "not found", under the right name. The
 * URL pins the host the user typed. Kept pure so that is testable without a
 * `glab` binary.
 */
export function glabCloneArgs(ref: RepoRef, dir: string): string[] {
  return ['repo', 'clone', ref.cloneUrl, dir, '--', '--progress'];
}

const cloneGitlabOverHttps: CloneRunner = async (ref, dir, onLine, signal) => {
  const url = ref.cloneUrl ?? `https://gitlab.com/${ref.slug}.git`;
  const viaGlab = await spawnClone('glab', glabCloneArgs(ref, dir), onLine, signal);
  if (viaGlab.ok || !viaGlab.notFound) return viaGlab;
  return spawnClone('git', ['clone', '--progress', url, dir], onLine, signal);
};

/** The runner for a ref's forge. `gh` and `glab`/`git` are not interchangeable:
 *  `gh` resolves a slug against github.com and nothing else. */
export function cloneRunnerFor(ref: RepoRef): CloneRunner {
  return ref.forge === 'gitlab' ? gitlabCloneRunner : ghCloneRunner;
}

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
  /** Raw user input: `owner/repo`, or a GitHub or GitLab URL. */
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
    return {
      ok: false,
      status: 400,
      error: `not a GitHub or GitLab repository: ${opts.url.trim().slice(0, 200)}`,
    };
  }
  const name = (opts.name ?? '').trim() === '' ? ref.repo : (opts.name ?? '').trim();
  if (!isValidCheckoutName(name)) {
    return { ok: false, status: 400, error: `not a valid folder name: ${name.slice(0, 200)}` };
  }
  if (!isAbsolutePath(opts.projectsDir)) {
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

  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCloneRunner : cloneRunnerFor(ref));
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
      // Which CLI is missing depends on the forge — and for GitLab a missing
      // `git` is the only way to get here at all, since `glab` being absent
      // falls back rather than failing.
      const reason = ref.forge === 'gitlab'
        ? 'git not found — install it (or the GitLab CLI, `glab auth login`) to clone from GitLab'
        : 'gh CLI not found — install it and run `gh auth login`';
      emit({ phase: 'error', error: reason });
      return { ok: false, status: 503, error: reason, reason };
    }
    const error = ref.forge === 'gitlab' ? explainGitlabAuth(outcome.error, ref) : outcome.error;
    emit({ phase: 'error', error });
    return { ok: false, status: 500, error };
  }

  emit({ phase: 'done' });
  return { ok: true, target, name };
}

/** Does this failure mean the clone wanted credentials and could not ask? */
const NEEDS_CREDENTIALS = /could not read Username|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied/i;

/**
 * Add the missing half of git's own message, for the one GitLab failure that is
 * unreadable without it.
 *
 * GitLab answers 401 for a project that is private AND for one that does not
 * exist — deliberately, so an anonymous probe cannot enumerate private projects.
 * Git turns that into "could not read Username for 'https://gitlab.com'", which
 * is true, does not look like an auth failure (prompts are disabled here), and
 * tells the operator nothing about what to do. Verified against gitlab.com.
 *
 * Appended, never substituted: git's line names the URL it actually tried, and
 * this module is otherwise built on showing the CLI's own words rather than a
 * paraphrase. Applied HERE rather than in the runner because it is a property of
 * the forge, not of which command happened to run — an authenticated `glab`
 * failing the same way earns the same explanation.
 */
function explainGitlabAuth(error: string, ref: RepoRef): string {
  if (ref.transport === 'ssh') return explainGitlabSsh(error, ref);
  if (!NEEDS_CREDENTIALS.test(error)) return error;
  return `${error}\n\ngitlab.com answers the same way for a private project and one that does not `
    + `exist, so this is either — check ${ref.slug}, and for a private project install the GitLab `
    + 'CLI and run `glab auth login` (cezar uses it when it is there), configure a git '
    + `credential helper for gitlab.com, or — if your GitLab login is an ssh key — paste the ssh `
    + `address instead (git@gitlab.com:${ref.slug}.git).`;
}

/** The ssh failures worth a sentence, each with the one thing that fixes it. */
function explainGitlabSsh(error: string, ref: RepoRef): string {
  if (/Host key verification failed/i.test(error)) {
    return `${error}\n\nThis machine has not accepted gitlab.com's host key yet, and cezar cannot answer `
      + 'that prompt for you — run `ssh -T git@gitlab.com` once in a terminal, accept the key, and retry.';
  }
  if (/Permission denied \(publickey|Could not read from remote repository|could not be found or you don't have permission/i.test(error)) {
    return `${error}\n\ngitlab.com refused the ssh key cezar's process offered, or ${ref.slug} does not exist `
      + '(gitlab.com answers the same way for both). A key that works in your terminal may need an '
      + 'agent this process can reach (`ssh-add`), or a passphrase-free deploy key.';
  }
  return error;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
