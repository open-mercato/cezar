import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONTAINER_AGENTS, GUEST_CLAUDE_LOGIN_DIR } from './container-agents.ts';
import type { LaunchOpts, ProcessLauncher } from './process-launcher.ts';
import { containerEnvPairs, guestKillScript, guestScript } from './container-runtime.ts';
import type { SandboxConfig } from '../config.ts';
import {
  credentialEnvPairs,
  credentialMountArgs,
  isGuestPath,
  isVolumeName,
  resolvePassthrough,
  type ResolvedCredential,
} from './credential-passthrough.ts';
import { agentKimiHome, kimiHome } from './kimi-home.ts';

/**
 * Run the agent in a Podman container while cezar stays on the host.
 *
 * Podman because nothing here needs an account: no registry login, no OAuth token in the macOS
 * keychain, and therefore no dependence on a GUI session, so it works over ssh. Containers live
 * exactly as long as we say.
 *
 * The layout, and why each part is the way it is:
 *
 *  - **The repo is mounted at its own absolute path** (`-v /Users/x:/Users/x`).
 *    cwd, `--add-dir`, the task worktree and `CEZ_HANDOFF_FILE` are then the
 *    same strings on both sides, so nothing translates paths — the single
 *    largest source of bugs in this kind of feature simply cannot occur.
 *  - **Tools live in the image, not in a setup step.** A repo builds its own
 *    image once (`Containerfile`); every task starts from it with the toolchain
 *    already present. Reinstalling per task is the thing this exists to avoid.
 *  - **Containers are per task, caches are shared.** A fresh container per task
 *    keeps tasks from polluting each other; named cache volumes (npm, pnpm)
 *    keep package installs warm anyway. Isolation without the cold start.
 *  - **Auth is passed through at file granularity.** Claude Code keeps its
 *    credential in `~/.claude/.credentials.json` and its conversations in
 *    `projects/`, `sessions/`, `history.jsonl`. Mounting only the credential
 *    gives the agent a working login while your conversation history stays
 *    invisible to it. The mount is read-WRITE on purpose: Claude Code refreshes
 *    the OAuth token and rewrites that file, so a read-only mount works right
 *    up until the token expires and then fails inscrutably.
 */

/** Where the agent's own `~/.claude` lives on the host — its conversations, not yours. */
export function agentClaudeHome(): string {
  return join(homedir(), '.claude-agent');
}

/** The host credential passed through to the container (Tier 1 passthrough). */
export function hostClaudeCredential(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/**
 * The host's Kimi login directories passed through to an isolated Kimi agent, as
 * `[host path, guest path]`. `credentials/` holds the OAuth tokens; `oauth/` the per-credential
 * lock files Kimi takes while refreshing one.
 *
 * DIRECTORIES, mounted — the opposite of Claude's credential, and for the same reason. Kimi also
 * rewrites a refreshed token by temp-file-plus-rename, which strands a FILE bind mount on the
 * unlinked inode (see `podmanRunArgs`); a directory mount holds the directory's inode, which a
 * rename inside it never replaces, so both sides always see the current file. It is also why a
 * copy is not the answer here: were a refresh to rotate the refresh token, a copy refreshed inside
 * the container would silently log the host out, and vice versa. One shared directory cannot
 * diverge.
 */
export function hostKimiLogin(env: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
  const home = kimiHome(env);
  return [
    [join(home, 'credentials'), `${GUEST_KIMI_HOME}/credentials`],
    [join(home, 'oauth'), `${GUEST_KIMI_HOME}/oauth`],
  ];
}

/** Where an isolated Kimi agent's home is mounted — the image's `kimi` runs as root. */
export const GUEST_KIMI_HOME = '/root/.kimi-code';

/** The shared base every repo image builds FROM, shipped with cezar itself. */
export const BASE_IMAGE_TAG = 'localhost/cezar-agent/base:latest';

/** The follow-up inbox an isolated agent writes, inside the run's scratch dir — see `podmanExec`. */
export const ISOLATED_TODOS_FILE = 'todos.json';

/**
 * The image a repo's containers run. Precedence, highest first:
 *
 *  1. **its Containerfile**, if it has one — the repo's own declared toolchain
 *     is the most specific statement about what its agents need, and a config
 *     key must not silently shadow a file sitting in the repo. An `image` pin
 *     that overrode it produced exactly that: a project with a Containerfile
 *     quietly running the generic base, and a settings page saying so in words
 *     nobody connected to the pin;
 *  2. an explicit `sandbox.image`, for a repo that would rather point at a
 *     prebuilt image than write a Containerfile;
 *  3. the shared base — the only fallback, and only when there is nothing else.
 */
export function imageTag(cfg: SandboxConfig, hasContainerfile = true): string {
  if (hasContainerfile) return `cezar-agent/${cfg.name}:latest`;
  return cfg.image ?? BASE_IMAGE_TAG;
}

/** `podman build` argv for a repo's image. Run once per Containerfile change. */
export function podmanBuildArgs(cfg: SandboxConfig, containerfile: string, contextDir: string): string[] {
  return ['build', '-t', imageTag(cfg), '-f', containerfile, contextDir];
}

/**
 * `podman run` argv for one task's container. Detached and idle (`sleep
 * infinity`): cezar `exec`s the agent into it, possibly several times across a
 * multi-turn session, and tears it down when the task ends.
 */
export function podmanRunArgs(
  cfg: SandboxConfig,
  containerName: string,
  workspace: string,
  opts: {
    credentialPassthrough: boolean;
    credentials?: ResolvedCredential[];
    /** Forwarded to the host on loopback, for HTTP-speaking backends. */
    publishPort?: number;
    /** Whether the repo has a Containerfile — decides base vs derived tag. */
    hasContainerfile?: boolean;
    /** Injectable for tests; defaults to a real filesystem check. */
    credentialExists?: (path: string) => boolean;
    /** The task this container serves. Decides which parts of the repo are writable. */
    runId?: string;
    /** This project's agent homes on the host (`agentHomesFor`). */
    homes?: { claude: string; kimi: string };
    /** The container-only Claude login to mount (`containerLoginPlan`), when this turn gets it. */
    claudeLoginDir?: string;
    /**
     * The agent CLIs this task runs. An agent's own login reaches only a task that runs it — a
     * Claude task has no business holding the operator's Kimi login. Absent means "unknown", and
     * passes none.
     */
    backends?: readonly string[];
    /** The selected agent account's env (`KIMI_CODE_HOME`), whose login is passed. */
    accountEnv?: Record<string, string>;
    /** Injectable for tests. */
    fs?: RepoFs;
  } = { credentialPassthrough: true },
): string[] {
  const homes = opts.homes ?? { claude: agentClaudeHome(), kimi: agentKimiHome() };
  const args = [
    'run', '--detach', '--name', containerName,
    // The repo at its own absolute path — writable only where a task must write (see `repoMounts`).
    ...repoMounts(workspace, opts.runId, opts.fs),
    // The agent's OWN claude home, per project: conversations land on the host, readable from here
    // and impossible to strand inside a container that is gone.
    '-v', `${homes.claude}:/root/.claude`,
    // The same for Kimi — and it is also where cezar reads a Kimi turn's token usage from, since
    // Kimi logs it to its session files rather than the wire.
    '-v', `${homes.kimi}:${GUEST_KIMI_HOME}`,
    // Every other runner's home beside them, so a Continue finds its conversation after the
    // container is recreated. Per-project homes only (`agentHomesFor`); all of them, so switching
    // runner mid-task is not a mount change.
    ...(opts.homes
      ? Object.values(CONTAINER_AGENTS).flatMap((agent) => ['-v', `${join(dirname(homes.claude), agent.id)}:${agent.guestHome}`])
      : []),
    // The container-only Claude login, as a directory so Claude's write-then-rename of a refreshed
    // token lands on the host — only where `containerLoginPlan` allows it. Mounted even before
    // `cez container-login claude` has run, so setting it up later is not a mount change.
    ...(opts.claudeLoginDir ? ['-v', `${opts.claudeLoginDir}:${GUEST_CLAUDE_LOGIN_DIR}`] : []),
  ];
  // Kimi's login, mounted at directory granularity (see `hostKimiLogin`): only for a task that
  // runs Kimi, and the SELECTED account's — an agent profile's KIMI_CODE_HOME, not the default's.
  // Only what exists: podman refuses a missing mount source.
  if (opts.credentialPassthrough && opts.backends?.includes('kimi')) {
    const exists = opts.credentialExists ?? existsSync;
    for (const [host, guest] of hostKimiLogin({ ...process.env, ...opts.accountEnv })) {
      if (exists(host)) args.push('-v', `${host}:${guest}`);
    }
  }
  // The Claude credential is deliberately NOT mounted — it is copied in, and
  // re-copied before every agent spawn (`syncClaudeCredential`).
  //
  // A bind mount binds an INODE, not a path. Claude Code refreshes its OAuth
  // token by writing a temp file and renaming over the original, which unlinks
  // the inode the container holds: the directory entry lingers, every read
  // fails with ENOENT, and once the old token expires the agent reports "Not
  // logged in". Observed in practice after ~35 hours. Mounting a single file
  // that its owner rewrites atomically cannot work; copying it can, and
  // re-copying keeps it fresh.
  // Package caches survive the per-task container, so a fresh container still
  // installs fast. This is what makes "container per task" affordable.
  // NAMED volumes only. The key is spliced into `-v <key>:<target>`, so a path-shaped key would
  // bind that host directory — `{"/Users/me": "/h"}` mounted a whole home — and a `:` in either
  // half would smuggle mount options. Anything else is skipped, not trusted.
  for (const [volume, target] of Object.entries(cfg.cacheVolumes ?? {})) {
    if (isVolumeName(volume) && isGuestPath(target)) args.push('-v', `${volume}:${target}`);
  }
  // Anonymous volumes: a bare target with no source. Podman creates one per
  // container and drops it on `rm -v`, which is exactly the lifetime build
  // output should have — and it shadows the slow bind mount at that path.
  for (const target of cfg.ephemeralPaths ?? []) {
    args.push('-v', target);
  }
  // Credentials the operator explicitly passed through. Mounts only — the
  // copies happen after the container exists (`credentialCopyPlan`).
  args.push(...credentialMountArgs(opts.credentials ?? resolvePassthrough(cfg.credentials)));
  // Loopback only: the agent's HTTP server is cezar's business and nobody
  // else's, so it is reachable from this machine and not from the network.
  if (opts.publishPort) args.push('-p', `127.0.0.1:${opts.publishPort}:${opts.publishPort}`);
  // Resource limits. `--shm-size` is the one that is set by DEFAULT, because
  // podman's 64m default kills any headless browser the agent starts and does
  // so with an error that reads as out-of-memory.
  if (cfg.resources?.shmSize) args.push('--shm-size', cfg.resources.shmSize);
  if (cfg.resources?.memory) args.push('--memory', cfg.resources.memory);
  if (cfg.resources?.cpus) args.push('--cpus', String(cfg.resources.cpus));
  args.push(imageTag(cfg, opts.hasContainerfile ?? true), 'sleep', 'infinity');
  return args;
}

/**
 * Where git finds code to run: `config` (fsmonitor, sshCommand, filters, aliases…), `hooks`,
 * `info` and the submodules' own git dirs. `prepareHostDirs` creates the missing ones so an agent
 * cannot create them under a writable `.git`.
 */
export const GIT_EXEC_PATHS = ['config', 'hooks', 'info', 'modules'] as const;

export interface RepoFs {
  exists: (path: string) => boolean;
  isDir: (path: string) => boolean;
}

const realFs: RepoFs = {
  exists: existsSync,
  isDir: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * The repo's mounts for one task's container: read-only, except what the task must write.
 *
 * The repo used to be mounted read-WRITE whole, and the host acts on files in it: host `git`
 * obeys `.git/config` (`core.fsmonitor`, filters, `core.sshCommand`) and `.git/hooks`, so an agent
 * that wrote one had code running on the Mac at the next `git status`, diff or autosave — with
 * every credential isolation exists to keep from it. `.ai/cezar/config.json` (which credentials
 * and mounts this repo's containers get), automations, private MCP config and skills are read by
 * the host too, and so is the operator's own checkout (`.envrc`, `.claude/settings.json`,
 * `.mcp.json`).
 *
 * A worktree task (the ordinary case) gets the repo read-only, with writable holes for exactly:
 * its own worktree, its scratch dir, the runs dir (its handoff file lives there), the dispatch
 * channel, and the git stores a commit or fetch writes — objects, refs, logs and this worktree's
 * own git dir. The worktree's `.git` pointer and its git dir's `commondir`/`gitdir` stay read-only:
 * rewritten, they would point host git at a config the agent wrote. Its `config.worktree` too,
 * when it exists (`extensions.worktreeConfig` makes git read it).
 *
 * An in-place task (no worktree) works in the checkout itself, so it stays writable; only the
 * git config, hooks and info dir, and cezar's own state, are made read-only. Weaker by
 * construction — an in-place run has no copy to work on.
 */
export function repoMounts(repoRoot: string, runId: string | undefined, fs: RepoFs = realFs): string[] {
  const out: string[] = [];
  const bind = (path: string, readOnly = false): void => {
    out.push('-v', `${path}:${path}${readOnly ? ':ro' : ''}`);
  };
  const gitDir = join(repoRoot, '.git');
  const data = join(repoRoot, '.ai', 'cezar');
  const worktree = runId ? join(data, 'worktrees', runId) : undefined;
  const hasGitDir = fs.isDir(gitDir);
  // What host git EXECUTES from, or what aims the operator's own checkout: read-only in both
  // modes. The rest of `.git` stays writable — git takes `packed-refs.lock` at its top level for
  // every ref deletion (even CHERRY_PICK_HEAD), so a read-only `.git` broke reset/cherry-pick.
  const guarded = (names: readonly string[]): void => {
    for (const name of names) {
      const path = join(gitDir, name);
      if (fs.exists(path)) bind(path, true);
    }
  };
  if (worktree && fs.isDir(worktree)) {
    bind(repoRoot, true);
    if (hasGitDir) {
      bind(gitDir);
      guarded([...GIT_EXEC_PATHS, 'worktrees', 'HEAD', 'index']);
      const ownGitDir = join(gitDir, 'worktrees', runId!);
      if (fs.isDir(ownGitDir)) {
        bind(ownGitDir);
        for (const name of ['commondir', 'gitdir', 'config.worktree']) {
          const path = join(ownGitDir, name);
          if (fs.exists(path)) bind(path, true);
        }
      }
    }
    bind(worktree);
    const pointer = join(worktree, '.git');
    if (fs.exists(pointer) && !fs.isDir(pointer)) bind(pointer, true);
  } else {
    bind(repoRoot);
    if (hasGitDir) guarded([...GIT_EXEC_PATHS, 'worktrees']);
    if (fs.isDir(data)) bind(data, true);
  }
  // cezar's own state a task writes, in either mode.
  if (runId) {
    for (const path of [join(data, 'tmp', runId), join(data, 'runs')]) {
      if (fs.isDir(path)) bind(path);
    }
  }
  const dispatch = join(data, 'dispatch');
  if (fs.isDir(dispatch)) bind(dispatch);
  return out;
}

/**
 * GitHub tokens `buildChildEnv` forwards to every agent on the host. Inside a container they would
 * hand the operator's GitHub identity to a task whose GitHub CLI was never ticked, so they cross
 * only when it was (`github-cli`), in which case the ticked credential supplies them anyway.
 */
const GITHUB_TOKEN_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

/**
 * `podman exec` for one agent process inside an existing container: the argv, and the env the
 * `podman` client itself is spawned with.
 *
 * Values are NEVER on the argv. `-e KEY=VALUE` put every secret — Vault values, `GH_TOKEN`, API
 * keys, private MCP config — on the command line of a process that lives for the whole turn,
 * readable by anything that can list processes. `-e KEY` alone makes podman read the value from
 * its own environment, which is where they go instead.
 */
export function podmanExec(
  cfg: SandboxConfig,
  containerName: string,
  bin: string,
  args: string[],
  opts: LaunchOpts,
  pidFile: string,
  /**
   * `KEY=VALUE` pairs fetched from a secret store on the host, already resolved
   * upstream. They arrive pre-resolved because fetching is async and this
   * builder is deliberately synchronous and pure — the property its tests rest
   * on. The container receives values, never the credential that fetched them.
   */
  fetchedEnv: readonly string[] = [],
  /** Sign Claude in from the mounted container-only login (`containerLoginPlan().use`). */
  containerLogin = false,
): { args: string[]; env: Record<string, string> } {
  const resolved = resolvePassthrough(cfg.credentials);
  const githubTicked = resolved.some((c) => c.id === 'github-cli' && !c.skipped);
  // Credentials passed as environment variables (AWS_PROFILE, a custom
  // STRIPE_API_KEY…). Applied per EXEC rather than baked into the container, so
  // a token rotated on the host reaches the next turn of a long task. Read from
  // the host env, not from `opts.env`, which `buildChildEnv` has already
  // filtered — that filtering is why they were absent before.
  const base = containerEnvPairs({ ...opts.env, CEZ_PID_FILE: pidFile }, cfg.tmpdir)
    .filter((pair) => githubTicked || !GITHUB_TOKEN_NAMES.has(pair.slice(0, pair.indexOf('='))));
  const env: Record<string, string> = {};
  for (const pair of [...base, ...credentialEnvPairs(resolved), ...fetchedEnv]) {
    const at = pair.indexOf('=');
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  // `.ai/cezar` — and the inbox in it — is read-only in here, so follow-ups go to the run's own
  // writable scratch dir (the HOST path, mounted at the same path) and the engine moves them into
  // the inbox at turn end. An empty CEZ_TODOS_FILE is "follow-ups off" and stays empty.
  if (env.CEZ_TODOS_FILE && opts.env?.TMPDIR) env.CEZ_TODOS_FILE = join(opts.env.TMPDIR, ISOLATED_TODOS_FILE);
  if (containerLogin) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = GUEST_CLAUDE_LOGIN_DIR;
  Object.assign(env, containerGitConfig(env));
  return {
    args: [
      'exec',
      // `-i` keeps stdin open for the stream-json conversation. No `-t`: cezar
      // pipes rather than allocating a terminal, and a pty would corrupt the
      // protocol with echo and line editing.
      '-i',
      '-w', opts.cwd,
      ...Object.keys(env).sort().flatMap((name) => ['-e', name]),
      containerName,
      // Nothing is unset: `buildChildEnv` forwards the host's REAL `ANTHROPIC_*` in the env above,
      // and unsetting it would delete the only credential an API-key user has.
      'sh', '-c', guestScript(),
      'cez-podman', bin, ...args,
    ],
    env,
  };
}

/**
 * `.git/config` is read-only in a task container, so git settings that would WRITE it are turned
 * off: `switch -c x origin/main` recording an upstream, and a plain `git push` needing one
 * (`push.default=current` pushes the branch to its own name instead). Appended to any
 * `GIT_CONFIG_COUNT` the env already carries.
 */
export function containerGitConfig(env: Record<string, string>): Record<string, string> {
  const settings: Array<[string, string]> = [['branch.autoSetupMerge', 'false'], ['push.default', 'current']];
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + settings.length) };
  settings.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return out;
}

/** The argv half of `podmanExec` — names only, never values. */
export function podmanExecArgs(
  cfg: SandboxConfig,
  containerName: string,
  bin: string,
  args: string[],
  opts: LaunchOpts,
  pidFile: string,
  fetchedEnv: readonly string[] = [],
): string[] {
  return podmanExec(cfg, containerName, bin, args, opts, pidFile, fetchedEnv).args;
}

export class PodmanLauncher implements ProcessLauncher {
  readonly id = 'podman' as const;
  private readonly pidFiles = new WeakMap<ChildProcessWithoutNullStreams, string>();

  constructor(
    private readonly cfg: SandboxConfig,
    /** The container to exec into; the engine creates it per task. */
    private readonly containerName: string,
    private readonly bin = 'podman',
    /** The port published when the container was created, if any. */
    readonly publishedPort?: number,
    /**
     * Secrets fetched on the host for this turn (`KEY=VALUE`).
     *
     * Held on the launcher rather than fetched per spawn because `spawn` is
     * synchronous by contract — every runner depends on it returning a child
     * process, not a promise. The engine re-resolves them on each step and
     * Continue, so a rotated secret still reaches the next turn.
     */
    private readonly fetchedEnv: readonly string[] = [],
    /** This project's agent homes on the host — see `ProcessLauncher.agentHomes`. */
    readonly agentHomes?: { claude: string; kimi: string },
    /** Claude signs in from the mounted container-only login this turn (`containerLoginPlan`). */
    private readonly containerLogin = false,
  ) {}

  describe(): string {
    return `podman container "${this.containerName}" (image ${imageTag(this.cfg)})`;
  }

  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams {
    const pidFile = `${this.cfg.tmpdir}/cez-${randomUUID()}.pid`;
    const exec = podmanExec(this.cfg, this.containerName, bin, args, opts, pidFile, this.fetchedEnv, this.containerLogin);
    const child = nodeSpawn(
      this.bin,
      exec.args,
      // The host env is what `podman` itself needs; the values of the `-e NAME` the agent gets ride
      // on top, where podman reads them — never on the argv (see `podmanExec`).
      { cwd: opts.cwd, env: { ...process.env, ...exec.env } },
    ) as ChildProcessWithoutNullStreams;
    this.pidFiles.set(child, pidFile);
    return child;
  }

  /**
   * Signal the process INSIDE the container. Killing the `podman exec` client
   * does not propagate, so a host-only kill would leave the agent running and
   * the run hung. The client is killed too, so the runner's stream closes
   * either way.
   */
  async signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void> {
    const pidFile = this.pidFiles.get(child);
    if (pidFile) {
      await new Promise<void>((resolve) => {
        const killer = nodeSpawn(
          this.bin,
          ['exec', this.containerName, 'sh', '-c', guestKillScript(pidFile, sig)],
          { stdio: 'ignore' },
        );
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      });
    }
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}
