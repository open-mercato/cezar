import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { BASE_IMAGE_TAG, GIT_EXEC_PATHS, hostClaudeCredential, imageTag, podmanBuildArgs, podmanRunArgs } from './podman-launcher.ts';
import { agentHomesFor, agentKimiHome, kimiHome } from './kimi-home.ts';
import {
  CONTAINER_AGENTS,
  containerAgent,
  containerLoginPlan,
  isImageExtra,
  syncContainerAgentLogin,
  withoutRefreshTokens,
} from './container-agents.ts';
import type { SandboxConfig } from '../config.ts';
import { parseMachines } from './container-probe.ts';
import {
  CREDENTIAL_CATALOG,
  credentialCopyPlan,
  resolvePassthrough,
  sanitizeSshConfig,
  type ResolvedCredential,
} from './credential-passthrough.ts';

const run = promisify(execFile);

/**
 * Per-task container lifecycle: the piece that turns `sandbox.enabled` into an
 * actually isolated run.
 *
 * The split is deliberate and is the answer to "each task must not start from a
 * clean image":
 *
 *  - the **image** is built once per repo from its `Containerfile` and holds the
 *    toolchain, so no task ever reinstalls it;
 *  - the **container** is per task, so one task cannot leave state that another
 *    inherits — which is most of what isolation is for;
 *  - **cache volumes** are shared and permanent, so package installs stay warm
 *    even though the container is new. That is what makes per-task affordable.
 *
 * Everything here is best-effort in one specific sense: a failure must be LOUD.
 * If the container cannot be prepared, the caller runs the task locally and says
 * so — a silent fallback would run model-authored shell commands on the host
 * while the config promised a sandbox.
 */

export class PodmanUnavailable extends Error {}

/** Container name for a run. Prefixed so a stray one is obviously cezar's. */
export function taskContainerName(runId: string): string {
  return `cez-${runId.slice(0, 8)}`;
}

async function podman(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(bin, args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new PodmanUnavailable((e.stderr || e.message || 'podman failed').trim());
  }
}

/**
 * Build the repo's image if it is not present. A missing Containerfile is not
 * an error: the repo simply has no image of its own and the configured (or
 * default) tag is expected to exist already — pulled, or built by hand.
 */
/** `containers/agent-base.Containerfile`, in the installed package or the checkout. */
export function baseContainerfilePath(): string {
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', 'containers', 'agent-base.Containerfile');
}

/**
 * Build the shared base image if this machine does not have it yet.
 *
 * Without this, isolation works only on a machine where someone built the base
 * by hand — and fails everywhere else with "image is not present", naming a tag
 * the user has never heard of. The base is cezar's own artifact, so cezar
 * builds it.
 */
export function ensureBaseImage(
  bin = 'podman',
  /** CLIs the image must carry beyond Claude and Kimi: runners and credential tools (`isImageExtra`). */
  agents: readonly string[] = [],
): Promise<void> {
  // Every project builds FROM the one base, so its builds queue machine-wide (see `serialized`).
  return serialized(imageChains, `base\0${bin}`, () => ensureBaseImageOnce(bin, agents));
}

async function ensureBaseImageOnce(bin: string, agents: readonly string[]): Promise<void> {
  const file = baseContainerfilePath();
  const exists = await run(bin, ['image', 'exists', BASE_IMAGE_TAG]).then(() => true).catch(() => false);
  if (!existsSync(file)) {
    if (exists) return;
    throw new PodmanUnavailable(
      `the cezar agent base image is missing and ${file} was not found — reinstall cezar, or set ` +
        '`sandbox.image` to an image that exists',
    );
  }
  // Rebuilt when the shipped Containerfile changed — a cezar upgrade that adds
  // an agent CLI (Kimi did) must reach machines that built the base before it.
  // By CONTENT, stamped on the image as a label: an installed package's files
  // all carry npm's fixed 1985 mtime, so a date comparison could never fire.
  const hash = baseContainerfileHash(file);
  // The runner CLIs it carries are stamped beside the hash. A rebuild keeps every one an earlier
  // task needed and adds this task's, so the image grows only with what is actually used.
  const have = exists ? parseAgentsLabel(await imageLabel(BASE_IMAGE_TAG, BASE_AGENTS_LABEL, bin)) : [];
  const want = parseAgentsLabel([...have, ...agents].join(','));
  const fresh = exists && (await imageLabel(BASE_IMAGE_TAG, BASE_HASH_LABEL, bin)) === hash;
  if (fresh && want.every((agent) => have.includes(agent))) return;
  await podman(bin, [
    'build', '-t', BASE_IMAGE_TAG,
    '--label', `${BASE_HASH_LABEL}=${hash}`,
    '--label', `${BASE_AGENTS_LABEL}=${want.join(',')}`,
    '--build-arg', `CEZ_AGENTS=${want.join(' ')}`,
    '-f', file, dirname(file),
  ]);
}

/** The label listing the runner CLIs a base image was built with. */
const BASE_AGENTS_LABEL = 'dev.cezar.agents';

/** Known runner ids only, sorted and unique — a label is read back from an image, not trusted. */
function parseAgentsLabel(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((a) => a.trim()).filter(isImageExtra))].sort();
}

/** The label carrying the hash of the Containerfile a base image was built from. */
const BASE_HASH_LABEL = 'dev.cezar.containerfile-sha256';

export function baseContainerfileHash(file = baseContainerfilePath()): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function imageLabel(tag: string, label: string, bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(bin, ['image', 'inspect', tag, '--format', `{{index .Labels "${label}"}}`]);
    const value = stdout.trim();
    return value && value !== '<no value>' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One image build at a time per tag, QUEUED rather than shared: two tasks that need different CLIs
 * each get their check, in turn, against what the previous build left — sharing one in-flight build
 * let the last of two parallel builds win the tag without the other's CLI. A queued check of an
 * image that is already right costs a few `podman image inspect`s.
 */
function serialized(chains: Map<string, Promise<void>>, key: string, work: () => Promise<void>): Promise<void> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  chains.set(key, next);
  void next.catch(() => undefined).finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

const imageChains = new Map<string, Promise<void>>();

export async function ensureImage(
  cfg: SandboxConfig,
  repoRoot: string,
  bin = 'podman',
  /** CLIs this task needs in the image (see `ensureBaseImage`). */
  extras: readonly string[] = [],
): Promise<void> {
  return serialized(imageChains, `${bin}\0${repoRoot}\0${cfg.image ?? ''}\0${cfg.containerfile}`, () =>
    ensureImageOnce(cfg, repoRoot, bin, extras));
}

async function ensureImageOnce(
  cfg: SandboxConfig,
  repoRoot: string,
  bin: string,
  agents: readonly string[],
): Promise<void> {
  const containerfile = join(repoRoot, cfg.containerfile);
  const hasFile = existsSync(containerfile);
  if (!hasFile) {
    // An explicit pin is expected to exist already — cezar has nothing to build
    // it from — so only the base is built here.
    if (cfg.image) return;
    // No repo Containerfile: the base IS the image for this project. A repo
    // with no toolchain of its own is the ordinary case, not a
    // misconfiguration — and the settings page promises exactly this ("tasks
    // run on the generic base image"). Throwing here made the DEFAULT config
    // unable to isolate at all.
    await ensureBaseImage(bin, agents);
    return;
  }
  // A repo Containerfile builds FROM the base, so the base has to be current
  // first — and a base rebuilt just now makes the repo image stale with it.
  await ensureBaseImage(bin, agents);
  const tag = imageTag(cfg, hasFile);
  const exists = await run(bin, ['image', 'exists', tag]).then(() => true).catch(() => false);
  // An existing image is reused UNLESS its Containerfile has changed since it
  // was built, or the base under it has. That is what makes an accepted
  // suggestion take effect on the NEXT task rather than never: without this
  // check a stale tag would be reused forever, and rebuilding unconditionally
  // would pay a full image build before every task, which is exactly the cost
  // this design avoids.
  if (
    exists &&
    !(await containerfileIsNewer(containerfile, tag, bin)) &&
    !(await imageIsOlderThan(tag, BASE_IMAGE_TAG, bin))
  ) {
    return;
  }
  await podman(bin, podmanBuildArgs(cfg, containerfile, repoRoot));
}

/** Was `tag` built before `base`? Unreadable either way answers `false` — never a rebuild loop. */
async function imageIsOlderThan(tag: string, base: string, bin: string): Promise<boolean> {
  const created = async (image: string) => {
    try {
      const { stdout } = await run(bin, ['image', 'inspect', image, '--format', '{{.Created}}']);
      return Date.parse(stdout.trim());
    } catch {
      return Number.NaN;
    }
  };
  const [mine, theirs] = await Promise.all([created(tag), created(base)]);
  return !Number.isNaN(mine) && !Number.isNaN(theirs) && mine < theirs;
}

/**
 * Was the Containerfile edited after the image was built? Compares the file's
 * mtime with the image's creation stamp. Unreadable either way answers `false`:
 * a probe that cannot tell must not trigger a rebuild before every task.
 */
async function containerfileIsNewer(containerfile: string, tag: string, bin: string): Promise<boolean> {
  try {
    const { stdout } = await run(bin, ['image', 'inspect', tag, '--format', '{{.Created}}']);
    const built = Date.parse(stdout.trim());
    if (Number.isNaN(built)) return false;
    return statSync(containerfile).mtimeMs > built;
  } catch {
    return false;
  }
}

/**
 * Start this task's container, building the image first if needed. Returns the
 * container name for `createLauncher`. Idempotent: an existing container with
 * the same name is reused, which is what makes a Continue land in the same
 * place as the run it resumes.
 */
export async function startTaskContainer(
  cfg: SandboxConfig,
  repoRoot: string,
  runId: string,
  bin = 'podman',
  opts: {
    /** The agent CLI this turn runs; its login — and only its — is passed. */
    backend?: string;
    /** The selected agent account's env (`CLAUDE_CONFIG_DIR`, `KIMI_CODE_HOME`): whose login. */
    accountEnv?: Record<string, string>;
    /** A fork head's code: no long-lived login reaches it (`containerLoginPlan`). */
    untrusted?: boolean;
  } = {},
): Promise<TaskContainer> {
  const name = taskContainerName(runId);
  const startedMachine = await ensurePodmanMachine(bin);
  const homes = agentHomesFor(repoRoot);
  prepareHostDirs(repoRoot, runId, homes);
  const passLogins = cfg.claudeCredentialPassthrough;
  const containerLogin = containerLoginPlan({ backend: opts.backend, passLogins, untrusted: opts.untrusted, accountEnv: opts.accountEnv });
  const runOpts = {
    runId,
    homes,
    backends: opts.backend ? [opts.backend] : [],
    accountEnv: opts.accountEnv ?? {},
    ...(containerLogin.mountDir ? { claudeLoginDir: containerLogin.mountDir } : {}),
  };
  let running = await run(bin, ['container', 'exists', name]).then(() => true).catch(() => false);
  // A mount is fixed when a container is created, so one that changed during a task — a
  // credential ticked or narrowed, a different agent, a hardened repo layout — never reached it:
  // a ticked Railway login stayed missing, and a narrowed `~/.ssh` stayed mounted whole. This runs
  // between turns, with no agent process inside, and everything a task needs to continue lives on
  // the host — the worktree and the agent's conversation are both bind mounts — so the container
  // is recreated with exactly the mounts it should have. What goes is container-only state: a
  // background server, a package installed outside the repo.
  let remounted: string[] | undefined;
  if (running) {
    const drift = await mountDrift(name, wantedMounts(cfg, repoRoot, name, runOpts), cfg.ephemeralPaths ?? [], bin);
    if (drift.length > 0) {
      await run(bin, ['rm', '-f', '-v', name]).catch(() => undefined);
      running = false;
      remounted = drift;
    }
  }
  const agent = containerAgent(opts.backend);
  const credentials = resolvePassthrough(cfg.credentials);
  const extras = imageExtras(agent, credentials);
  const hasContainerfile = existsSync(join(repoRoot, cfg.containerfile));
  let addedAgent: string | undefined;
  if (running) {
    // A stopped container from an earlier turn has to be woken — before it is probed: `exec` into
    // a stopped container fails, and that failure is not "the CLI is there".
    await run(bin, ['start', name]).catch(() => undefined);
    // A runner whose CLI the container's image lacks — the first Codex turn of a task that ran
    // Claude — gets a container from an image that has it. Only when a rebuilt image WOULD have
    // it (it derives from cezar's base, whose label lists its CLIs): a pinned image or a repo
    // image FROM something else never gains one, and recreating it every turn changes nothing.
    if (agent && (await hasBinary(name, agent.bin, bin)) === false) {
      await ensureImage(cfg, repoRoot, bin, extras);
      if (!(await imageCarries(imageTag(cfg, hasContainerfile), agent.id, bin))) throw new MissingAgentCli(agent, imageTag(cfg, hasContainerfile));
      await run(bin, ['rm', '-f', '-v', name]).catch(() => undefined);
      running = false;
      addedAgent = agent.id;
    }
  }
  if (running) {
    // Every spawn re-copies, so a token refreshed on the host reaches the next
    // turn of a long task — the property a mount was supposed to give and
    // could not (see `podmanRunArgs`).
    const login = await syncAgentLogins(name, bin, homes, opts, passLogins, containerLogin.use);
    // And the same for everything else that is COPIED, so a credential ticked
    // after this container started reaches the next turn of the task instead of
    // waiting for a task that does not exist yet.
    await applyCredentials(name, credentials, bin);
    return {
      name,
      homes,
      publishedPort: await publishedPortOf(name, bin),
      ...(startedMachine ? { startedMachine } : {}),
      ...(login?.expiresAt !== undefined ? { claudeLoginExpiresAt: login.expiresAt } : {}),
      ...(login?.missingLogin ? { missingLogin: login.missingLogin } : {}),
      ...(containerLogin.use ? { claudeContainerLogin: true } : {}),
    };
  }
  // Allocated BEFORE the container exists, because publishing is a
  // creation-time property: an HTTP-speaking backend that discovers it needs a
  // port later would have nowhere to put it.
  const publishPort = await freePort();
  await ensureImage(cfg, repoRoot, bin, extras);
  if (passLogins && opts.backend === 'kimi') syncKimiConfig(join(kimiHome({ ...process.env, ...opts.accountEnv }), 'config.toml'), homes.kimi);
  await podman(bin, podmanRunArgs(cfg, name, repoRoot, {
    credentialPassthrough: passLogins,
    credentials,
    publishPort,
    hasContainerfile,
    ...runOpts,
  }));
  // An image cezar cannot add the CLI to (pinned, or a repo image not built FROM the base): this
  // turn runs on the host, saying why, rather than exec a CLI that is not there under an
  // "isolated" badge. Checked once the container exists, so a pin that DOES carry it isolates.
  if (agent && (await hasBinary(name, agent.bin, bin)) === false) throw new MissingAgentCli(agent, imageTag(cfg, hasContainerfile));
  // Copies happen after the container exists, because `podman cp` needs a
  // target. Failing to place one is not fatal to the run: the agent will report
  // the tool being logged out, which is a far clearer symptom than a container
  // that refused to start.
  const login = await syncAgentLogins(name, bin, homes, opts, passLogins, containerLogin.use);
  await applyCredentials(name, credentials, bin);
  return {
    name,
    homes,
    publishedPort: publishPort,
    ...(startedMachine ? { startedMachine } : {}),
    ...(remounted ? { remounted } : {}),
    ...(addedAgent ? { addedAgent } : {}),
    ...(login?.expiresAt !== undefined ? { claudeLoginExpiresAt: login.expiresAt } : {}),
    ...(login?.missingLogin ? { missingLogin: login.missingLogin } : {}),
    ...(containerLogin.use ? { claudeContainerLogin: true } : {}),
  };
}

/** The agent's own login, for the agent this turn runs, from the selected account. */
async function syncAgentLogins(
  name: string,
  bin: string,
  homes: { claude: string; kimi: string },
  opts: { backend?: string; accountEnv?: Record<string, string> },
  passLogins: boolean,
  useContainerLogin: boolean,
): Promise<{ expiresAt?: number; missingLogin?: string } | undefined> {
  if (!passLogins) return undefined;
  let login: { expiresAt?: number; missingLogin?: string } | undefined;
  if (opts.backend === undefined || opts.backend === 'claude' || opts.backend === 'claude-cli') {
    const configDir = opts.accountEnv?.CLAUDE_CONFIG_DIR?.trim() || undefined;
    // The container-only login refreshes itself (`containerLoginPlan`); a copy is only the fallback.
    if (!useContainerLogin) {
      login = await syncClaudeCredential(name, bin, undefined, hostClaudeLogins(configDir));
    }
  }
  if (opts.backend === 'kimi') {
    syncKimiConfig(join(kimiHome({ ...process.env, ...opts.accountEnv }), 'config.toml'), homes.kimi);
  }
  const agent = containerAgent(opts.backend);
  if (agent && !syncContainerAgentLogin(agent, join(dirname(homes.claude), agent.id), { ...process.env, ...opts.accountEnv })) {
    login = { ...login, missingLogin: agent.id };
  }
  return login;
}

/**
 * Create, on the host, every directory a task's container mounts — podman refuses a missing
 * source, and one it creates itself inside the VM is root-owned and unwritable by the agent —
 * and, once, bring this project's conversations over from the shared agent home of earlier
 * cezar versions, so a Continue still finds its session. Best-effort throughout.
 */
function prepareHostDirs(repoRoot: string, runId: string, homes: { claude: string; kimi: string }): void {
  const data = join(repoRoot, '.ai', 'cezar');
  const runnerHomes = Object.values(CONTAINER_AGENTS).map((agent) => join(dirname(homes.claude), agent.id));
  for (const dir of [homes.claude, homes.kimi, ...runnerHomes, join(data, 'tmp', runId), join(data, 'runs')]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // the mount is skipped when its source is missing
    }
  }
  migrateLegacyClaudeSessions(repoRoot, homes.claude);
  // `.git` is writable in the container except these, overlaid read-only — which only works for
  // a path that exists. An absent `hooks` would otherwise be the agent's to create.
  if (existsSync(join(repoRoot, '.git', 'config'))) {
    for (const name of [...GIT_EXEC_PATHS, 'worktrees']) {
      if (name === 'config') continue;
      try {
        mkdirSync(join(repoRoot, '.git', name), { recursive: true });
      } catch {
        // unwritable .git: the overlay is skipped and the mount table says so
      }
    }
  }
  // `extensions.worktreeConfig` makes git read the worktree's own `config.worktree`, which lives in
  // the git dir the task must write. It is mounted read-only (`repoMounts`) — which needs it to
  // exist first.
  try {
    const gitConfig = readFileSync(join(repoRoot, '.git', 'config'), 'utf8');
    const ownGitDir = join(repoRoot, '.git', 'worktrees', runId);
    if (/worktreeconfig\s*=\s*true/i.test(gitConfig) && existsSync(ownGitDir)) {
      const file = join(ownGitDir, 'config.worktree');
      if (!existsSync(file)) writeFileSync(file, '');
    }
  } catch {
    // no git dir, or not a worktree task
  }
}

/**
 * Earlier versions kept ONE `~/.claude-agent` for every isolated task. Claude files a session
 * under `projects/<cwd with every non-alphanumeric as "-">`, so this project's sessions are the
 * entries starting with its root encoded the same way — copied (never moved: an older cezar
 * may still be running) into the per-project home, once.
 */
function migrateLegacyClaudeSessions(repoRoot: string, claudeHome: string): void {
  try {
    const legacy = join(homedir(), '.claude-agent', 'projects');
    const target = join(claudeHome, 'projects');
    if (!existsSync(legacy) || existsSync(target)) return;
    const prefix = repoRoot.replace(/[^A-Za-z0-9]/g, '-');
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(legacy)) {
      if (entry === prefix || entry.startsWith(`${prefix}-`)) {
        cpSync(join(legacy, entry), join(target, entry), { recursive: true });
      }
    }
  } catch {
    // a Continue then starts a fresh session — the worktree is intact either way
  }
}

/** One mount as podman reports it, reduced to what decides whether a container still fits. */
export interface MountSpec {
  /** `bind` for a host path, `volume` for a named volume. */
  type: 'bind' | 'volume';
  /** Host path (bind) or volume name (volume). */
  source: string;
  destination: string;
  readOnly: boolean;
}

/**
 * The mounts this task's container should have, read off the very argv that would create it — so
 * this cannot drift from `podmanRunArgs`. Anonymous volumes (`ephemeralPaths`) are per-container
 * scratch and are left out.
 */
export function wantedMounts(
  cfg: SandboxConfig,
  repoRoot: string,
  name: string,
  runOpts: {
    runId?: string;
    homes?: { claude: string; kimi: string };
    backends?: readonly string[];
    accountEnv?: Record<string, string>;
    claudeLoginDir?: string;
  } = {},
): MountSpec[] {
  const args = podmanRunArgs(cfg, name, repoRoot, {
    credentialPassthrough: cfg.claudeCredentialPassthrough,
    credentials: resolvePassthrough(cfg.credentials),
    hasContainerfile: existsSync(join(repoRoot, cfg.containerfile)),
    ...runOpts,
  });
  const out: MountSpec[] = [];
  args.forEach((arg, i) => {
    if (args[i - 1] !== '-v') return;
    const [source, destination, options] = arg.split(':');
    if (!source || !destination) return;
    out.push({
      type: source.startsWith('/') ? 'bind' : 'volume',
      source: trimSlash(source),
      destination: trimSlash(destination),
      readOnly: (options ?? '').split(',').includes('ro'),
    });
  });
  return out;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * How the container's mounts differ from the wanted ones, as human-readable guest paths: wanted
 * and absent, present and no longer wanted, or present with the wrong source or access. Empty when
 * it fits. Unreadable answers none — never a reason to recreate a container on a probe that could
 * not tell.
 */
export async function mountDrift(
  name: string,
  wanted: readonly MountSpec[],
  ephemeralPaths: readonly string[],
  bin: string,
): Promise<string[]> {
  let have: MountSpec[];
  try {
    const { stdout } = await run(bin, ['inspect', name, '--format', '{{json .Mounts}}']);
    const rows = JSON.parse(stdout.trim() || '[]') as Array<{ Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }>;
    have = rows
      .filter((row) => row.Destination)
      .map((row) => ({
        type: row.Type === 'volume' ? 'volume' as const : 'bind' as const,
        source: trimSlash(row.Type === 'volume' ? row.Name ?? '' : row.Source ?? ''),
        destination: trimSlash(row.Destination!),
        readOnly: row.RW === false,
      }));
  } catch {
    return [];
  }
  if (have.length === 0) return [];
  const ephemeral = new Set(ephemeralPaths.map(trimSlash));
  const key = (m: MountSpec) => `${m.type}|${m.source}|${m.destination}|${m.readOnly}`;
  const wantedKeys = new Set(wanted.map(key));
  const haveKeys = new Set(have.filter((m) => !(m.type === 'volume' && ephemeral.has(m.destination))).map(key));
  const drift = new Set<string>();
  for (const m of wanted) if (!haveKeys.has(key(m))) drift.add(m.destination);
  for (const m of have) {
    if (m.type === 'volume' && ephemeral.has(m.destination)) continue;
    if (!wantedKeys.has(key(m))) drift.add(m.destination);
  }
  return [...drift];
}

/**
 * Place the COPIED credentials into a container that already exists.
 *
 * Separate from container creation on purpose, and callable on a running
 * container: a copy can be refreshed at any time, which is the whole practical
 * difference between the two mechanisms. A mount is fixed when the container is
 * created, so changing one means recreating the container and losing the task's
 * running state — that is why narrowed ssh keys are copies, and why ticking a
 * key can take effect in the session you are already in.
 *
 * Every step is best-effort: a credential that fails to land shows up as the
 * tool reporting itself logged out, which is a far clearer symptom than a
 * container that refused to start.
 */
export async function applyCredentials(
  container: string,
  credentials: ResolvedCredential[],
  bin = 'podman',
): Promise<void> {
  // Never through a mount. A path under a bind-mounted directory IS the host's file: a container
  // created when `~/.ssh` was passed through whole still has it mounted after the operator
  // narrowed to single keys, and "copying" the narrowed key, chmodding it or — on un-tick —
  // `rm -f`-ing it then rewrote or DELETED the operator's real key on the Mac. Such a container is
  // recreated with the right mounts on its next turn (`mountDrift`); until then, hands off.
  const mounted = await mountDestinations(container, bin);
  const plan = credentialCopyPlan(credentials, container).filter((args) => {
    const dest = args[2]?.split(':')[1];
    return dest !== undefined && !isUnderMount(dest, mounted);
  });
  const placing = plan.map((args) => args[2]?.split(':')[1]).filter((p): p is string => Boolean(p));
  // REVOKE before granting. Un-ticking a credential used to change the config
  // and nothing in the container: this function only ever copied, so a revoked
  // ssh key stayed usable in every running container — and in any reused one
  // on later turns — while the settings page said the change applied to the
  // task you are in. The manifest records what cezar itself placed, so only
  // that is ever removed; files the agent made are not cezar's to delete.
  for (const path of await readCredentialManifest(container, bin)) {
    if (placing.includes(path) || isUnderMount(path, mounted)) continue;
    await run(bin, ['exec', container, 'rm', '-f', path]).catch(() => undefined);
  }
  for (const planned of plan) {
    // A credential that has to be rewritten on the way in is copied from a
    // temp file instead of straight from the operator's own.
    const credential = credentials.find((c) => c.hostPath === planned[1]);
    const staged = credential?.sanitize ? stageSanitized(credential) : undefined;
    const args = staged ? ['cp', staged, planned[2] as string] : planned;
    // `podman cp` fails when the destination's parent is absent, and the base
    // image has no `/root/.config/gh` or `/root/.docker`. Without this the copy
    // failed silently and the agent reported the tool as logged out, with
    // nothing in the run log to explain why.
    const dest = args[2]?.split(':')[1];
    if (dest) await run(bin, ['exec', container, 'mkdir', '-p', dirname(dest)]).catch(() => undefined);
    await run(bin, args).catch(() => undefined);
    // And then the modes, where the credential declares them. An SSH private
    // key that lands group-readable is REFUSED by ssh ("UNPROTECTED PRIVATE KEY
    // FILE") — it does not warn and continue, it declines to use the key, which
    // reads downstream as "permission denied (publickey)" with nothing
    // connecting it to the copy.
    const perms = dest ? permsFor(credentials, dest) : undefined;
    if (dest && perms) {
      await run(bin, ['exec', container, 'chmod', perms.dir, dirname(dest)]).catch(() => undefined);
      await run(bin, ['exec', container, 'chmod', perms.file, dest]).catch(() => undefined);
    }
    // The whole temp DIRECTORY, not just the file: removing the file alone left one empty
    // `cez-cred-*` directory behind per turn.
    if (staged) rmSync(dirname(staged), { recursive: true, force: true });
  }
  await writeCredentialManifest(container, placing, bin);
}

/** Every mount destination of a container. Unreadable answers EVERYTHING-is-mounted for safety:
 *  `undefined`, which `isUnderMount` reads as "touch nothing". */
async function mountDestinations(container: string, bin: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(bin, ['inspect', container, '--format', '{{range .Mounts}}{{.Destination}}\n{{end}}']);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return undefined;
  }
}

/** Is `path` a mount destination or inside one? An unknown mount table means yes. */
export function isUnderMount(path: string, mounts: readonly string[] | undefined): boolean {
  if (mounts === undefined) return true;
  return mounts.some((m) => path === m || path.startsWith(m.endsWith('/') ? m : `${m}/`));
}

/**
 * Where cezar records, INSIDE a container, the credential files it copied in.
 *
 * In the container rather than on the host so it lives and dies with the thing
 * it describes, and survives a cockpit restart between turns. Mounts are not in
 * it: a bind mount is fixed at creation and cannot be withdrawn from a running
 * container — a revoked MOUNTED credential stays until the container is
 * recreated, which is why copies are the default for anything narrowed.
 */
const CREDENTIAL_MANIFEST = '/root/.cezar-credentials.json';

async function readCredentialManifest(container: string, bin: string): Promise<string[]> {
  try {
    const { stdout } = await run(bin, ['exec', container, 'cat', CREDENTIAL_MANIFEST]);
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    // Absolute paths only, no climbing. Not limited to /root: a custom credential may name any
    // guest path, and was never revoked when it lay elsewhere. The file lives in the container, so
    // an agent could edit it — which is why every removal also refuses a path under a mount
    // (`isUnderMount`): the worst an edited manifest does is delete a file inside the container.
    return parsed.filter((p): p is string =>
      typeof p === 'string' && p.startsWith('/') && !p.split('/').includes('..'));
  } catch {
    return []; // first apply, or a container from before the manifest existed
  }
}

async function writeCredentialManifest(container: string, paths: string[], bin: string): Promise<void> {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-manifest-'));
    const file = join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(paths), { mode: 0o600 });
    await run(bin, ['cp', file, `${container}:${CREDENTIAL_MANIFEST}`]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: without it the next apply cannot revoke, which is the old
    // behaviour rather than a new failure.
  }
}

/**
 * Push the project's COPIED credentials into every running container of that
 * project, and answer the ones that were updated.
 *
 * This is what makes ticking a key in Settings take effect in the task you are
 * already in, rather than in some future one. It is possible at all only
 * because narrowed credentials are copies: a mount is fixed when the container
 * is created, so the same change to a mounted credential could only be applied
 * by destroying the container and the running task with it.
 *
 * Containers are matched by the workspace they have mounted, not by a name or a
 * label we maintain: a container's own mount list is the only statement about
 * which repo it belongs to that cannot drift. Pushing one project's credentials
 * into another project's container is the failure worth designing against here.
 */
export async function applyCredentialsToRunning(
  cfg: SandboxConfig,
  repoRoot: string,
  bin = 'podman',
  /** Injectable for tests; defaults to running the real `podman`. */
  ask: PodmanQuery = (args) => run(bin, args).then(({ stdout }) => stdout),
): Promise<string[]> {
  let names: string[];
  try {
    names = (await ask(['ps', '--format', '{{.Names}}']))
      .split('\n').map((n) => n.trim()).filter((n) => n.startsWith('cez-'));
  } catch {
    return []; // no podman, or no VM — nothing to update and nothing to report
  }
  if (names.length === 0) return [];
  // No early return on an empty grant list: "revoke everything" is exactly
  // the change that must reach running containers.
  const credentials = resolvePassthrough(cfg.credentials);
  const updated: string[] = [];
  // A few at a time rather than one after another: each container is a handful
  // of podman round-trips into the VM, ~4–5s together, and a project with a
  // dozen task containers took most of a minute sequentially. Bounded, because
  // every exec is a process on the host and a hop into the same VM.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const name = names[next++]!;
      if (!(await mountsWorkspace(name, repoRoot, ask))) continue;
      await applyCredentials(name, credentials, bin);
      updated.push(name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(APPLY_CONCURRENCY, names.length) }, worker));
  return updated.sort();
}

const APPLY_CONCURRENCY = 4;

/**
 * `applyCredentialsToRunning` for a settings save: queued per project and NOT awaited by the
 * caller.
 *
 * The save itself is the config write; reaching the task containers that are already running is
 * a follow-up that took ~50s with a dozen of them. Awaited, it held the request that long, and the
 * page showed nothing until a reload — the secret was saved, the answer was not back.
 *
 * Queued so two quick saves cannot race: a push that started earlier must never finish later and
 * put back a credential the newer save revoked. Each push reads the config when it RUNS, so the
 * last one always applies the latest choice, and a push queued behind a running one is the only
 * one kept — the ones in between would apply what it applies anyway.
 */
export function pushCredentialsToRunning(
  repoRoot: string,
  load: () => Promise<SandboxConfig | undefined>,
  apply: (cfg: SandboxConfig, repoRoot: string) => Promise<unknown> = applyCredentialsToRunning,
): Promise<void> {
  const queued = queuedPushes.get(repoRoot);
  if (queued) return queued;
  const previous = runningPushes.get(repoRoot) ?? Promise.resolve();
  const push: Promise<void> = previous.then(async () => {
    queuedPushes.delete(repoRoot);
    runningPushes.set(repoRoot, push);
    try {
      const cfg = await load();
      if (cfg) await apply(cfg, repoRoot);
    } catch {
      // podman missing, VM down — the save itself is unaffected, and the next
      // turn of each task copies its credentials in anyway.
    } finally {
      if (runningPushes.get(repoRoot) === push) runningPushes.delete(repoRoot);
    }
  });
  queuedPushes.set(repoRoot, push);
  return push;
}

const runningPushes = new Map<string, Promise<void>>();
const queuedPushes = new Map<string, Promise<void>>();

/** Reads something from podman. Answers its stdout; throws as `podman` does. */
export type PodmanQuery = (args: string[]) => Promise<string>;

/** Does this container have `repoRoot` bind-mounted — i.e. is it this project's? */
async function mountsWorkspace(container: string, repoRoot: string, ask: PodmanQuery): Promise<boolean> {
  try {
    const mounts = await ask(['inspect', container, '--format', '{{range .Mounts}}{{.Source}}\n{{end}}']);
    return mounts.split('\n').some((line) => line.trim() === repoRoot);
  } catch {
    return false;
  }
}

/**
 * Write the rewritten form of a credential to a temp file, and answer its path.
 * `undefined` when anything goes wrong — the caller then copies the original,
 * which is the pre-existing behaviour rather than a new failure.
 */
function stageSanitized(credential: ResolvedCredential): string | undefined {
  if (!credential.hostPath) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-cred-'));
    try {
      const staged = join(dir, basename(credential.hostPath));
      writeFileSync(staged, sanitizeSshConfig(readFileSync(credential.hostPath, 'utf8')), { mode: 0o600 });
      return staged;
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The modes declared for whichever credential landed at `dest`, if any. */
function permsFor(credentials: ResolvedCredential[], dest: string): { file: string; dir: string } | undefined {
  return credentials.find((c) => c.guestPath === dest)?.perms;
}

/** What `startTaskContainer` hands back: where to exec, and the forwarded port. */
export interface TaskContainer {
  name: string;
  /** Host port forwarded to the same port inside, for HTTP-speaking backends. */
  publishedPort?: number;
  /** Set when cezar had to start the stopped podman VM first — worth a line on the task. */
  startedMachine?: string;
  /** Guest paths whose mount changed since the container started, so it was recreated. */
  remounted?: string[];
  /** This project's agent homes on the host. */
  homes?: { claude: string; kimi: string };
  /** When the Claude access token handed to the container expires (ms since epoch). */
  claudeLoginExpiresAt?: number;
  /** The runner whose CLI the old container lacked, so it was recreated from an image with it. */
  addedAgent?: string;
  /** The runner this turn runs, when no login for it could be put in the container. */
  missingLogin?: string;
  /** Claude signs in from the mounted container-only login this turn (`containerLoginPlan`). */
  claudeContainerLogin?: boolean;
}

/**
 * Start the podman VM when it exists and is stopped (macOS/Windows; Linux has none).
 *
 * The VM stops on its own sometimes — memory pressure, its helper exiting; one stopped mid-week on
 * a machine that had not rebooted, with nothing in the system log — and every task asking for
 * isolation then ran UNISOLATED on the host with "Cannot connect to Podman". The operator turned
 * isolation on, so a stopped VM is a state to repair, not a reason to drop the guarantee: start
 * it, bounded, and let the task isolate as asked. One start at a time per process, so tasks
 * launched together share it. Answers the machine started, or undefined when nothing was needed;
 * throws `PodmanUnavailable` when it could not be started.
 */
export async function ensurePodmanMachine(
  bin = 'podman',
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform === 'linux') return undefined;
  if (machineStart) return machineStart;
  machineStart = (async () => {
    let machine: { running: boolean; name?: string };
    try {
      const { stdout } = await run(bin, ['machine', 'list', '--format', 'json'], { timeout: 10_000 });
      machine = parseMachines(stdout);
    } catch {
      return undefined; // cannot tell — let the container commands report what is wrong
    }
    if (machine.running || !machine.name) return undefined;
    try {
      await run(bin, ['machine', 'start', machine.name], { timeout: MACHINE_START_TIMEOUT_MS });
    } catch (err) {
      const detail = (err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err));
      throw new PodmanUnavailable(`podman's VM "${machine.name}" was stopped and could not be started: ${detail}`);
    }
    return machine.name;
  })().finally(() => {
    machineStart = undefined;
  });
  return machineStart;
}

let machineStart: Promise<string | undefined> | undefined;
const MACHINE_START_TIMEOUT_MS = 180_000;

/** An unused loopback port, asked of the OS rather than guessed. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Re-read the published port of a container we did not just create. */
async function publishedPortOf(name: string, bin: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(bin, ['port', name]);
    // "40123/tcp -> 127.0.0.1:40123"
    const match = /^(\d+)\/tcp/m.exec(stdout.trim());
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Every stored Claude login on the host for one account, as raw JSON: its `.credentials.json`
 * and, for the default account on macOS, the Keychain item — where a background cockpit's Claude
 * keeps it. Unreadable sources are skipped. The Keychain is never read under vitest.
 */
export async function hostClaudeLogins(configDir?: string): Promise<string[]> {
  const out: string[] = [];
  const file = configDir ? join(configDir, '.credentials.json') : hostClaudeCredential();
  try {
    out.push(readFileSync(file, 'utf8'));
  } catch {
    // no file login
  }
  if (!configDir && process.platform === 'darwin' && !process.env.VITEST) {
    try {
      const { stdout } = await run(
        'security',
        ['find-generic-password', '-a', userInfo().username, '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5_000 },
      );
      if (stdout.trim()) out.push(stdout.trim());
    } catch {
      // locked, absent, or not macOS's Keychain at all
    }
  }
  return out;
}

/**
 * The login a container may hold: the host login with the latest access-token expiry, with every
 * refresh token BLANKED. Refresh tokens are single-use — a container that refreshed its copy left
 * the host holding a spent one, and the host's next refresh logged the operator out of Claude
 * everywhere (2026-10-13). The host refreshes; containers get the result on their next turn.
 */
export function containerClaudeLogin(raws: readonly string[]): { json: string; expiresAt?: number } | undefined {
  let best: { value: Record<string, unknown>; expiresAt: number } | undefined;
  for (const raw of raws) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const oauth = (value as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken === '') continue;
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
    if (!best || expiresAt > best.expiresAt) best = { value: value as Record<string, unknown>, expiresAt };
  }
  if (!best) return undefined;
  return {
    json: JSON.stringify(withoutRefreshTokens(best.value)),
    ...(best.expiresAt > 0 ? { expiresAt: best.expiresAt } : {}),
  };
}

/**
 * Put the host's current Claude login into the container — WITHOUT its refresh token
 * (`containerClaudeLogin`). Answers when the copied access token expires.
 *
 * Copied rather than mounted, and re-copied before every spawn: Claude Code
 * rewrites that file atomically when it refreshes the token, which breaks a
 * file bind mount permanently (the container keeps the unlinked inode). A copy
 * has the opposite failure — it goes stale — and re-copying is what removes it.
 *
 * Silent when the host has no usable login: the container may hold its own.
 */
export async function syncClaudeCredential(
  container: string,
  bin = 'podman',
  /** Injectable for tests; defaults to running the real `podman`. */
  ask: PodmanQuery = (args) => run(bin, args).then(({ stdout }) => stdout),
  /** The host's stored logins, raw; injectable so this is testable off a real login. */
  logins: string[] | Promise<string[]> = hostClaudeLogins(),
): Promise<{ expiresAt?: number } | undefined> {
  const login = containerClaudeLogin(await logins);
  if (!login) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'cez-claude-login-'));
  try {
    const source = join(dir, '.credentials.json');
    writeFileSync(source, login.json, { mode: 0o600 });
    await copyClaudeLogin(container, ask, source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return login.expiresAt !== undefined ? { expiresAt: login.expiresAt } : {};
}

async function copyClaudeLogin(container: string, ask: PodmanQuery, source: string): Promise<void> {
  await ask(['exec', container, 'mkdir', '-p', GUEST_CREDENTIAL_DIR]).catch(() => undefined);
  await ask(['cp', source, `${container}:${GUEST_CREDENTIAL}`]).catch(() => undefined);
  if (await credentialReadable(container, ask)) return;
  // Unreadable after a successful copy means a container from an older cezar,
  // which BIND-MOUNTED this file. The mount holds an inode; Claude Code
  // rewrites the credential with temp-file-plus-rename when it refreshes or
  // when the operator logs in again, which unlinks it. The container is then
  // left holding a deleted file: `ls` still shows 508 bytes and every read
  // fails with ENOENT.
  //
  // The agent reports this as "Not logged in — please run /login", which sends
  // the operator to do the one thing that CANNOT help: logging in again on the
  // host rewrites the file once more and breaks the mount again. Seen twice.
  //
  // Restarting re-resolves the mount to the file that exists now. It is safe
  // here because this runs between turns, and it is narrow: only when the host
  // HAS a credential and the container still cannot read it.
  await ask(['restart', container]).catch(() => undefined);
  await ask(['cp', source, `${container}:${GUEST_CREDENTIAL}`]).catch(() => undefined);
}

/**
 * Put the host's Kimi `config.toml` in the isolated agent's home: its providers and the
 * `[models.*]` it may select, which is what makes `kimi-code/k3` resolvable in the container.
 * The login itself is MOUNTED (`hostKimiLogin`); this file only describes it, so a copy — renewed
 * before every turn, like Claude's credential — is enough. The agent home is a host directory
 * mounted at `/root/.kimi-code`, so this is a plain local copy, no `podman cp`.
 *
 * Silent when the host has no Kimi config: then there is no Kimi login to describe either.
 */
export function syncKimiConfig(source = join(kimiHome(), 'config.toml'), home = agentKimiHome()): void {
  try {
    if (!existsSync(source)) return;
    mkdirSync(home, { recursive: true });
    copyFileSync(source, join(home, 'config.toml'));
  } catch {
    // An unwritable agent home costs the Kimi agent its login, reported by Kimi itself.
  }
}

const GUEST_CREDENTIAL_DIR = '/root/.claude';
const GUEST_CREDENTIAL = `${GUEST_CREDENTIAL_DIR}/.credentials.json`;

/**
 * Can the agent actually READ the credential?
 *
 * `ls` is not the question and never was: a bind mount of an unlinked inode
 * still stats, with the right size and date. Only a read tells the truth.
 */
async function credentialReadable(container: string, ask: PodmanQuery): Promise<boolean> {
  try {
    await ask(['exec', container, 'head', '-c', '1', GUEST_CREDENTIAL]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `binary` on the container's PATH? Answered by what the probe PRINTS, never by its exit code:
 * dash (the base image's `sh`) exits 127 for "not found" where bash exits 1, and podman failing
 * has codes of its own. `undefined` when the probe itself failed — not an answer either way.
 */
async function hasBinary(container: string, binary: string, bin: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await run(
      bin,
      ['exec', container, 'sh', '-c', `if command -v ${binary} >/dev/null 2>&1; then echo present; else echo absent; fi`],
      { timeout: 15_000 },
    );
    if (stdout.includes('present')) return true;
    if (stdout.includes('absent')) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Does `tag` carry `id`? Read from the base's label, which an image built FROM it inherits. */
async function imageCarries(tag: string, id: string, bin: string): Promise<boolean> {
  return parseAgentsLabel(await imageLabel(tag, BASE_AGENTS_LABEL, bin)).includes(id);
}

/** The CLIs this turn needs in the image: its runner's, and any a ticked credential brings. */
function imageExtras(agent: { id: string } | undefined, credentials: readonly ResolvedCredential[]): string[] {
  const tools = credentials
    .filter((c) => !c.skipped)
    .map((c) => CREDENTIAL_CATALOG.find((source) => source.id === c.id)?.imageTool)
    .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
  return [...new Set([...(agent ? [agent.id] : []), ...tools])].sort();
}

/** This turn's runner has no CLI in the container's image and cezar cannot add it there. */
export class MissingAgentCli extends PodmanUnavailable {
  constructor(agent: { id: string; bin: string }, tag: string) {
    super(
      `the container image ${tag} has no \`${agent.bin}\` and cezar cannot add it (a pinned sandbox.image, or a `
        + `repo Containerfile not built FROM ${BASE_IMAGE_TAG}) — the ${agent.id} runner cannot run in a container here`,
    );
  }
}

/** Remove this task's container. Never throws — teardown must not fail a run. */
export async function removeTaskContainer(runId: string, bin = 'podman'): Promise<void> {
  // `-v` so the anonymous volumes (node_modules and friends) go with it —
  // without it every task would leak a multi-hundred-MB volume. Bounded: a
  // wedged podman VM must not hold a reclaim (or a boot sweep) open forever.
  await run(bin, ['rm', '-f', '-v', taskContainerName(runId)], { timeout: REMOVE_TIMEOUT_MS }).catch(() => undefined);
}

const REMOVE_TIMEOUT_MS = 30_000;

/**
 * Remove the containers of tasks whose worktree was just reclaimed or pruned. A container has
 * its worktree's lifetime (see `enforceRetention`), so every path that drops a worktree drops
 * its container too — otherwise each one leaked a stopped container and its volumes.
 *
 * `wasIsolated` gates the spawn: a host-only task never had a container, and a workspace that
 * never used isolation should not start a `podman` process at all. Fire-and-forget by design —
 * callers `void` it; it never throws.
 */
export async function removeContainersOf(
  runIds: readonly string[],
  wasIsolated: (runId: string) => boolean,
  bin = 'podman',
): Promise<void> {
  for (const runId of runIds) {
    if (wasIsolated(runId)) await removeTaskContainer(runId, bin);
  }
}
