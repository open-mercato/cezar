import { spawn } from 'node:child_process';
import { ghEnv } from '../core/gh-env.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GITHUB_REPO_NAME_PATTERN, type GithubOwner, type GithubOwnersResponse } from '@open-mercato/cezar-contract';
import { GH_CREDENTIAL_HELPER_CONFIG, cleanupCheckout, isValidCheckoutName, parseRepoRef, type CheckoutProgressEvent } from './checkout.ts';

/**
 * `POST /api/v1/projects/create` — the "Add project → New project" flow
 * (spec 2026-09-29-create-new-project).
 *
 * Three shapes, one target rule (`<projectsDir>/<name>`, shared with the clone
 * flow in `checkout.ts`, including its ownership-token `mkdir` and its guarded
 * cleanup):
 *
 * 1. **Local only** — `git init -b main` plus an empty initial commit, so the
 *    new project has a base commit a task worktree can branch from.
 * 2. **GitHub, empty** — the same local repo, then `gh repo create <owner>/<name>
 *    --private`, an HTTPS `origin`, and a plain `git push`.
 * 3. **GitHub, from a template** — `gh repo create <owner>/<name> --private
 *    --template <tmpl>`, wait for GitHub to finish generating it, then clone
 *    its HTTPS URL.
 *
 * Both GitHub paths persist the `gh` credential helper a clone gets (#968), so
 * a task worktree's later raw `git push` authenticates the same way.
 *
 * The repository is ALWAYS private: `--private` is a constant here, not a
 * parameter, and nothing in the request can reach it. Visibility is one click
 * on GitHub afterwards; an accidental public repo is not undoable.
 *
 * A GitHub repository is never deleted by cezar. If a later step fails after
 * `gh repo create` succeeded, the local folder is cleaned up exactly like a
 * failed clone, and the error says the remote repo exists — deleting it would
 * need the `delete_repo` scope and is not something to do on a network error.
 */

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const ERROR_TAIL_LINES = 6;
/** How long to wait for GitHub to generate a repo from a template before
 *  cloning anyway. Generation is asynchronous and usually takes a few seconds. */
const TEMPLATE_WAIT_ATTEMPTS = 15;
const TEMPLATE_WAIT_MS = 2_000;

/** The one initial branch name for a new local repo. */
const INITIAL_BRANCH = 'main';

export type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; notFound?: boolean };

/** Run one command (never through a shell). Injected so tests can drive the
 *  flow without `gh`, a network, or a git identity. `onLine` receives
 *  progress/stderr lines as they arrive. */
export type CommandRunner = (
  cmd: 'git' | 'gh',
  args: string[],
  opts: { cwd: string; onLine?: (line: string) => void; signal?: AbortSignal | undefined },
) => Promise<CommandResult>;

export const spawnCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
      // Non-interactive on purpose: a prompt nobody can see would pin the request.
      env: { ...ghEnv(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    const tail: string[] = [];
    let stdout = '';
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'project creation cancelled' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let pending = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      pending += chunk;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (line === '') continue;
        tail.push(line);
        if (tail.length > ERROR_TAIL_LINES) tail.shift();
        opts.onLine?.(line);
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      finish({ ok: false, error: err.message, notFound: (err as NodeJS.ErrnoException).code === 'ENOENT' });
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) return finish({ ok: true, stdout });
      const detail = [...tail, pending.trim(), stdout.trim()].filter((s) => s !== '').slice(-ERROR_TAIL_LINES).join('\n');
      finish({ ok: false, error: detail === '' ? `${cmd} ${args[0] ?? ''} exited with code ${code}` : detail });
    });
  });

/**
 * `CEZ_DRY_RUN=1` — real `git` (it is local and required anyway), fake `gh`.
 * The fake clone writes only inside the directory the caller created, as a real
 * (`git init`) repo: the `git config --local` that follows must find THIS repo,
 * never walk up past a bare `.git` folder into an enclosing one. `git push`
 * would need a real remote, so it is faked like `gh`.
 */
export const dryRunCommandRunner: CommandRunner = async (cmd, args, opts) => {
  if (cmd === 'git' && args[0] === 'push') {
    opts.onLine?.(`(CEZ_DRY_RUN=1) git ${args.join(' ')}`);
    return { ok: true, stdout: '' };
  }
  if (cmd === 'git') {
    // An empty commit needs an identity; a dry run must not depend on the
    // host's git config, so it lends one for that single call.
    const withIdentity =
      args[0] === 'commit' ? ['-c', 'user.name=cezar dry run', '-c', 'user.email=dry-run@cezar.invalid', ...args] : args;
    return spawnCommandRunner(cmd, withIdentity, opts);
  }
  opts.onLine?.(`(CEZ_DRY_RUN=1) gh ${args.join(' ')}`);
  if (args[0] === 'repo' && args[1] === 'clone') {
    const dir = args[3] ?? opts.cwd;
    const init = await spawnCommandRunner('git', ['init', '-b', INITIAL_BRANCH], { ...opts, cwd: dir });
    if (!init.ok) return init;
    await writeFile(join(dir, 'README.md'), `# ${args[2] ?? 'repo'}\n\n(CEZ_DRY_RUN=1 fake template clone)\n`, 'utf8');
  }
  if (args[0] === 'api') return { ok: true, stdout: '1\n' };
  return { ok: true, stdout: '' };
};

/**
 * Where creation stopped — `project_create_failed`'s telemetry label, so a closed set (the route
 * adds `register` for a project that was created but could not be registered). Never the error
 * text: that can carry paths and repository names.
 */
export type CreateProjectFailureStage =
  | 'invalid_input'
  | 'checkout_root'
  | 'folder_exists'
  | 'gh_missing'
  | 'cancelled'
  | 'git_init'
  | 'github_create'
  | 'template_clone';

export type CreateProjectFailure =
  | { ok: false; status: 400 | 409 | 500; error: string; stage: CreateProjectFailureStage }
  | { ok: false; status: 503; error: string; reason: string; stage: CreateProjectFailureStage };

/** `kind` — what was created: a local-only repo, an empty GitHub-backed one, or one from a
 *  template. `project_added`'s label (`new_<kind>`). */
export type CreateProjectResult =
  | { ok: true; target: string; name: string; slug?: string; kind: 'local' | 'github' | 'template' }
  | CreateProjectFailure;

export interface CreateProjectOptions {
  /** Project name — both the folder name and, with `github`, the repo name. */
  name: string;
  /** Present ⇒ also create a PRIVATE GitHub repository under `owner`. */
  github?: { owner: string; template?: string | undefined } | undefined;
  /** The checkout root, ALREADY `~`-expanded by the caller. */
  projectsDir: string;
  onProgress: (event: CheckoutProgressEvent) => void;
  checkoutId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam; defaults to spawning real commands (or the dry-run fake). */
  run?: CommandRunner;
  /** Test seam for the template wait. */
  sleep?: (ms: number) => Promise<void>;
}

const OWNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const GH_MISSING = 'gh CLI not found — install it and run `gh auth login`';

export async function createProject(opts: CreateProjectOptions): Promise<CreateProjectResult> {
  const name = opts.name.trim();
  // GitHub's repository-name rules, even for a local-only project: the name is
  // the folder AND (now or later) the repo, and GitHub would silently rewrite
  // anything else — `my project` becomes `my-project` there but not on disk.
  if (!GITHUB_REPO_NAME_PATTERN.test(name) || !isValidCheckoutName(name)) {
    return {
      ok: false,
      status: 400,
      stage: 'invalid_input',
      error: `not a valid project name: ${name.slice(0, 200)} — use letters, digits, ".", "-" and "_" only, no spaces`,
    };
  }
  let slug: string | undefined;
  let template: string | undefined;
  if (opts.github) {
    const owner = opts.github.owner.trim();
    if (owner.length > 64 || !OWNER_SEGMENT.test(owner)) {
      return { ok: false, status: 400, stage: 'invalid_input', error: `not a valid GitHub owner: ${owner.slice(0, 200)}` };
    }
    slug = `${owner}/${name}`;
    const rawTemplate = opts.github.template?.trim() ?? '';
    if (rawTemplate !== '') {
      const ref = parseRepoRef(rawTemplate);
      if (!ref) return { ok: false, status: 400, stage: 'invalid_input', error: `not a GitHub template repository: ${rawTemplate.slice(0, 200)}` };
      template = ref.slug;
    }
  }
  if (!opts.projectsDir.startsWith('/')) {
    return { ok: false, status: 500, stage: 'checkout_root', error: `checkout root is not an absolute path: ${opts.projectsDir}` };
  }
  const root = resolve(opts.projectsDir);
  const target = join(root, name);

  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    return { ok: false, status: 500, stage: 'checkout_root', error: `checkout root is not writable: ${errText(err)}` };
  }
  // The ownership token, exactly as in checkout.ts: non-recursive, so it
  // succeeds only when WE created the directory — which is what licenses the
  // cleanup below.
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, status: 409, stage: 'folder_exists', error: `folder already exists: ${target}` };
    }
    return { ok: false, status: 500, stage: 'checkout_root', error: `could not create ${target}: ${errText(err)}` };
  }

  const emit = (event: Omit<CheckoutProgressEvent, 'name' | 'checkoutId'>): void =>
    opts.onProgress({ ...event, name, ...(opts.checkoutId ? { checkoutId: opts.checkoutId } : {}) });
  const say = (line: string): void => emit({ phase: 'cloning', line });
  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCommandRunner : spawnCommandRunner);
  const exec = async (cmd: 'git' | 'gh', args: string[]): Promise<CommandResult> => {
    try {
      return await run(cmd, args, { cwd: target, onLine: say, signal: opts.signal });
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  };

  /** PR #968: route this repo's github.com HTTPS credentials through `gh`, as `checkout.ts` does. */
  const persistCredentialHelper = async (): Promise<CommandResult> => {
    for (const args of GH_CREDENTIAL_HELPER_CONFIG) {
      const result = await exec('git', ['config', '--local', ...args]);
      if (!result.ok) return { ok: false, error: `could not configure GitHub credentials: ${result.error}` };
    }
    return { ok: true, stdout: '' };
  };

  /** Clean up the local folder and answer with a failure. */
  const fail = async (
    outcome: { error: string; notFound?: boolean },
    remoteCreated: boolean,
    step: CreateProjectFailureStage,
  ): Promise<CreateProjectFailure> => {
    await cleanupCheckout(root, target);
    if (outcome.notFound) {
      emit({ phase: 'error', error: GH_MISSING });
      return { ok: false, status: 503, error: GH_MISSING, reason: GH_MISSING, stage: 'gh_missing' };
    }
    const error = remoteCreated && slug ? `${outcome.error}\n(the private repository ${slug} was created on GitHub)` : outcome.error;
    emit({ phase: 'error', error });
    return { ok: false, status: 500, error, stage: opts.signal?.aborted ? 'cancelled' : step };
  };

  if (slug && template) {
    say(`Creating private repository ${slug} from ${template}…`);
    const created = await exec('gh', ['repo', 'create', slug, '--private', '--template', template]);
    if (!created.ok) return fail(created, false, 'github_create');
    // Template generation is asynchronous on GitHub: an immediate clone can
    // land an empty repo. Wait until the first commit is visible.
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < TEMPLATE_WAIT_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) return fail({ error: 'project creation cancelled' }, true, 'cancelled');
      const probe = await exec('gh', ['api', `repos/${slug}/commits?per_page=1`, '--jq', 'length']);
      if (probe.ok && Number.parseInt(probe.stdout.trim(), 10) > 0) break;
      if (attempt === 0) say('Waiting for GitHub to generate the repository…');
      await sleep(TEMPLATE_WAIT_MS);
    }
    const cloned = await exec('gh', ['repo', 'clone', remoteUrl(slug), target, '--', '--progress']);
    if (!cloned.ok) return fail(cloned, true, 'template_clone');
    const helper = await persistCredentialHelper();
    if (!helper.ok) return fail(helper, true, 'template_clone');
    emit({ phase: 'done' });
    return { ok: true, target, name, slug, kind: 'template' };
  }

  say('Initializing a git repository…');
  const init = await exec('git', ['init', '-b', INITIAL_BRANCH]);
  if (!init.ok) return fail(init, false, 'git_init');
  // An empty commit gives the project a base commit to branch task worktrees
  // from, without writing any file the user did not ask for.
  const commit = await exec('git', ['commit', '--allow-empty', '-m', 'Initial commit']);
  if (!commit.ok) {
    // Most likely no git identity. A local-only project is still a fine git
    // repo without it; a GitHub push is not possible, so say why.
    say(`No initial commit: ${commit.error.split('\n')[0] ?? commit.error}`);
  }

  if (slug) {
    say(`Creating private repository ${slug}…`);
    const created = await exec('gh', ['repo', 'create', slug, '--private']);
    if (!created.ok) return fail(created, false, 'github_create');
    // HTTPS remote + gh credential helper, exactly as a clone gets (#968); the
    // push then goes through plain git, proving the setup a task push relies on.
    const remote = await exec('git', ['remote', 'add', 'origin', remoteUrl(slug)]);
    if (!remote.ok) return fail(remote, true, 'github_create');
    const helper = await persistCredentialHelper();
    if (!helper.ok) return fail(helper, true, 'github_create');
    if (commit.ok) {
      say(`Pushing ${INITIAL_BRANCH} to ${slug}…`);
      const pushed = await exec('git', ['push', '-u', 'origin', INITIAL_BRANCH]);
      if (!pushed.ok) return fail(pushed, true, 'github_create');
    }
  }

  emit({ phase: 'done' });
  return { ok: true, target, name, ...(slug ? { slug } : {}), kind: slug ? 'github' : 'local' };
}

/** `GET /api/v1/projects/github-owners` — who a new repository may belong to:
 *  the signed-in user first, then their organisations, each with its avatar
 *  (and an org's description) for the dialog's owner cards. */
export async function listGithubOwners(run?: CommandRunner): Promise<GithubOwnersResponse> {
  if (!run && process.env.CEZ_DRY_RUN === '1') {
    return {
      available: true,
      owners: [
        { login: 'dry-run-user', personal: true },
        { login: 'dry-run-org', personal: false, description: 'CEZ_DRY_RUN=1 fake organisation' },
      ],
    };
  }
  const exec = run ?? spawnCommandRunner;
  const cwd = process.cwd();
  const [user, orgs] = await Promise.all([
    exec('gh', ['api', 'user', '--jq', '[.login, .avatar_url // ""] | @tsv'], { cwd }).catch((err: unknown) => ({
      ok: false as const,
      error: errText(err),
    })),
    exec('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[] | [.login, .avatar_url // "", .description // ""] | @tsv'], {
      cwd,
    }).catch((err: unknown) => ({ ok: false as const, error: errText(err) })),
  ]);
  if (!user.ok) {
    if ('notFound' in user && user.notFound) return { available: false, reason: GH_MISSING };
    return { available: false, reason: `gh is not authenticated — run \`gh auth login\` (${user.error.split('\n')[0] ?? ''})` };
  }
  const me = parseOwnerLine(user.stdout.split('\n')[0] ?? '', true);
  if (!me) return { available: false, reason: 'gh returned no GitHub login' };
  // An org listing failure (e.g. a token without read:org) still leaves the
  // personal account — degrade to that rather than hide GitHub entirely.
  const orgOwners = new Map<string, GithubOwner>();
  if (orgs.ok) {
    for (const line of orgs.stdout.split('\n')) {
      const org = parseOwnerLine(line, false);
      if (org && org.login !== me.login) orgOwners.set(org.login, org);
    }
  }
  const sorted = [...orgOwners.values()].sort((a, b) => a.login.localeCompare(b.login));
  return { available: true, owners: [me, ...sorted] };
}

/** One `login<TAB>avatar[<TAB>description]` line from `gh --jq … | @tsv`.
 *  Only https avatars are passed on — the cockpit renders them as `<img src>`. */
function parseOwnerLine(line: string, personal: boolean): GithubOwner | null {
  const [login = '', avatar = '', ...rest] = line.split('\t');
  const trimmed = login.trim();
  if (!OWNER_SEGMENT.test(trimmed)) return null;
  // `@tsv` escapes tabs/newlines inside a field as `\t`/`\n`; fold them to spaces.
  const description = rest.join(' ').replace(/\\[tnr]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    login: trimmed,
    personal,
    ...(avatar.trim().startsWith('https://') ? { avatarUrl: avatar.trim() } : {}),
    ...(description !== '' ? { description: description.slice(0, 200) } : {}),
  };
}

/** The HTTPS remote, never the bare slug: `gh` would pick SSH from its own config, and an SSH key
 *  is what an organisation's SAML policy may reject (#968, `RepoRef.cloneUrl`). */
function remoteUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
