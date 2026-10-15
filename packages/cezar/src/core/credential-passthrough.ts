import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

/**
 * Which of the operator's credentials an isolated agent may use.
 *
 * Isolation without any credentials is useless — an agent that cannot reach
 * GitHub or a cloud project cannot do the work. Isolation with ALL of them is
 * pointless — the container would hold everything the host does. So this is the
 * dial in between, and it is per credential, on purpose.
 *
 * Two mechanisms, because they protect different things:
 *
 *  - **mount** — the container reads the live file. Refreshed tokens keep
 *    working, which is required for anything the tool rewrites (a cloud CLI
 *    refreshing an OAuth token). The cost is that the container can also WRITE
 *    it, and revoking means revoking for the host too.
 *  - **copy** — the container gets a snapshot at start. Nothing it does reaches
 *    the host's file, and the copy dies with the container. The cost is that a
 *    refresh inside does not persist, and a credential rotated on the host is
 *    stale in a long-running container.
 *
 * Mount is right for things that refresh, copy for static keys. Neither is
 * right for everything, which is why the choice is exposed rather than decided.
 *
 * One rule constrains the catalog, learned the hard way: **never file-mount
 * something its owner rewrites atomically.** A bind mount binds an inode, and a
 * temp-file-plus-rename unlinks it — the container is left holding a deleted
 * file, reads fail with ENOENT, and the tool reports itself logged out. Mount
 * the containing DIRECTORY (stable inode) or copy the file; both survive.
 */

export type PassthroughMode = 'mount' | 'copy';

export interface CredentialSource {
  /** Stable id — what the config names and the UI checkboxes. */
  id: string;
  /** What a human calls it. */
  label: string;
  /** Host path, `~`-relative. */
  hostPath?: string;
  /**
   * Whether `hostPath` is a file or a directory. Declared rather than sniffed:
   * `.ssh` and `.npmrc` are indistinguishable as strings, and this is what the
   * mount rule below is enforced against.
   */
  kind: 'file' | 'dir';
  /** Where it lands in the container. Defaults to the same path under /root. */
  guestPath?: string;
  /** Environment variables to forward instead of (or besides) a path. */
  env?: string[];
  /** Default mechanism for this source; the user may override. */
  defaultMode: PassthroughMode;
  /**
   * This source can be narrowed to individual files, which the UI lists and the
   * operator ticks. Only `~/.ssh` has this today, and it is the one credential
   * where all-or-nothing is genuinely dangerous: a single `~/.ssh` mount hands
   * the container every host every key reaches, production included, when the
   * task needed one deploy key.
   */
  selectable?: 'ssh';
  /** Why this one needs mount, when it does — shown in the UI. */
  note?: string;
  /** A CLI the base image installs only once this credential is ticked (`agent-base.Containerfile`). */
  imageTool?: 'azure-cli';
}

/**
 * The tools people actually hit this with. Each entry is the credential ONLY —
 * never a whole home directory, and never a tool's history or cache alongside
 * its key, for the same reason cezar mounts `.credentials.json` rather than all
 * of `~/.claude`.
 */
export const CREDENTIAL_CATALOG: CredentialSource[] = [
  {
    id: 'github-cli',
    kind: 'file',
    label: 'GitHub CLI (gh)',
    hostPath: '.config/gh/hosts.yml',
    guestPath: '/root/.config/gh/hosts.yml',
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    defaultMode: 'copy',
    note: 'A token, not a session — a copy is enough and keeps the container from rewriting it.',
  },
  {
    id: 'git-config',
    kind: 'file',
    label: 'Git identity (.gitconfig)',
    hostPath: '.gitconfig',
    guestPath: '/root/.gitconfig',
    defaultMode: 'copy',
    note: 'So commits the agent makes carry your name and email.',
  },
  {
    id: 'ssh',
    kind: 'dir',
    label: 'SSH keys',
    hostPath: '.ssh',
    guestPath: '/root/.ssh',
    defaultMode: 'mount',
    // Whole-directory is the fallback, not the recommendation: see `selectable`.
    selectable: 'ssh',
    note: 'Pick individual keys — the whole directory hands the container every host your keys reach.',
  },
  {
    id: 'gcloud',
    kind: 'dir',
    label: 'Google Cloud (gcloud)',
    hostPath: '.config/gcloud',
    guestPath: '/root/.config/gcloud',
    env: ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CORE_PROJECT'],
    defaultMode: 'mount',
    note: 'gcloud refreshes its OAuth token in place, so a copy goes stale.',
  },
  {
    id: 'railway',
    kind: 'dir',
    label: 'Railway CLI (railway)',
    hostPath: '.railway',
    guestPath: '/root/.railway',
    // A project token (`RAILWAY_TOKEN`) or an account/team token (`RAILWAY_API_TOKEN`) works
    // without any login on disk — the CI way, and enough on its own when the host exports one.
    env: ['RAILWAY_TOKEN', 'RAILWAY_API_TOKEN'],
    defaultMode: 'mount',
    note: 'railway rewrites config.json on login and on `railway link`; mounted, a login or a link on either side reaches the other — the repo sits at the same path in both, so links resolve.',
  },
  {
    id: 'azure',
    kind: 'dir',
    label: 'Azure CLI (az)',
    hostPath: '.azure',
    guestPath: '/root/.azure',
    // A service principal works without any login on disk — what SDKs and Terraform read.
    env: ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
    defaultMode: 'mount',
    note: 'az refreshes its MSAL token cache in place, so a copy goes stale. az itself (~640 MB) is added to the image the first time this is ticked.',
    imageTool: 'azure-cli',
  },
  {
    id: 'aws',
    kind: 'dir',
    label: 'AWS CLI',
    hostPath: '.aws',
    guestPath: '/root/.aws',
    env: ['AWS_PROFILE', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
    defaultMode: 'mount',
    note: 'SSO sessions are refreshed in place; static keys would be fine as a copy.',
  },
  {
    id: 'kube',
    kind: 'dir',
    label: 'Kubernetes (kubeconfig)',
    // The DIRECTORY, not `config` itself. Exec-based auth plugins rewrite the
    // kubeconfig to cache tokens, and they rewrite it atomically — which
    // permanently breaks a bind mount of the file (the container keeps the
    // unlinked inode and every read fails). A directory mount survives that
    // because the directory's own inode is stable. The same trap cost us the
    // Claude credential, which is now copied instead.
    hostPath: '.kube',
    guestPath: '/root/.kube',
    env: ['KUBECONFIG'],
    defaultMode: 'mount',
    note: 'The whole ~/.kube: exec auth plugins rewrite the config to cache tokens.',
  },
  {
    id: 'docker',
    kind: 'file',
    label: 'Container registry logins',
    hostPath: '.docker/config.json',
    guestPath: '/root/.docker/config.json',
    defaultMode: 'copy',
  },
  {
    id: 'npm',
    kind: 'file',
    label: 'npm registry token (.npmrc)',
    hostPath: '.npmrc',
    guestPath: '/root/.npmrc',
    env: ['NPM_TOKEN'],
    defaultMode: 'copy',
  },
  {
    id: 'pypi',
    kind: 'file',
    label: 'PyPI token (.pypirc)',
    hostPath: '.pypirc',
    guestPath: '/root/.pypirc',
    defaultMode: 'copy',
  },
];

/**
 * One file inside `~/.ssh` the operator can pass through on its own.
 *
 * Discovery reads the FILE, not its name: a private key is "starts with
 * `-----BEGIN`", because these are called `id_ed25519`, `github`, `work-deploy`
 * and anything else a person felt like, and a name-based guess would miss
 * exactly the keys someone bothered to name well.
 */
export interface SshEntry {
  /** File name inside `~/.ssh`. */
  name: string;
  kind: 'private-key' | 'config' | 'known-hosts';
  /** `ed25519 · kamil@mac`, read from the matching `.pub` when there is one. */
  detail?: string;
}

/** Injectable filesystem, so discovery is testable without a real `~/.ssh`. */
export interface SshFs {
  readdir(dir: string): string[];
  isFile(path: string): boolean;
  head(path: string, bytes: number): string;
}

const realSshFs: SshFs = {
  readdir: (dir) => readdirSync(dir),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  head: (path, bytes) => {
    try {
      return readFileSync(path, 'utf8').slice(0, bytes);
    } catch {
      return '';
    }
  },
};

/**
 * What is in `~/.ssh` that an agent could use, as a list the UI can offer.
 *
 * Deliberately NOT listed:
 *  - `authorized_keys` — that is who may log in to THIS machine. It grants the
 *    container nothing, and it is a list of other people's keys.
 *  - `*.pub` — a public key rides along with its private key automatically
 *    (see `resolvePassthrough`); as its own checkbox it is a decision with no
 *    consequence, and the point of this list is that every tick is a real one.
 *  - `*.old` backups, sockets, and directories (`~/.ssh/agent`).
 */
export function listSshEntries(home = homedir(), fs: SshFs = realSshFs): SshEntry[] {
  const dir = join(home, '.ssh');
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return []; // no ~/.ssh at all — the caller shows "not on this machine"
  }
  const entries: SshEntry[] = [];
  for (const name of names.sort()) {
    if (name === 'authorized_keys' || name.endsWith('.pub') || name.endsWith('.old')) continue;
    const path = join(dir, name);
    if (!fs.isFile(path)) continue;
    if (name === 'config') {
      entries.push({ name, kind: 'config' });
      continue;
    }
    if (name === 'known_hosts') {
      entries.push({ name, kind: 'known-hosts' });
      continue;
    }
    // The content test. 64 bytes covers every OpenSSH and PEM header.
    if (!fs.head(path, 64).startsWith('-----BEGIN')) continue;
    const pub = fs.head(`${path}.pub`, 4096).trim();
    entries.push({ name, kind: 'private-key', ...(describeKey(pub) ? { detail: describeKey(pub) } : {}) });
  }
  return entries;
}

/** `ssh-ed25519 AAAA… kamil@mac` → `ed25519 · kamil@mac`. */
function describeKey(pub: string): string | undefined {
  if (pub === '') return undefined;
  const [algorithm, , ...comment] = pub.split(/\s+/);
  const kind = algorithm?.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, '') ?? '';
  const who = comment.join(' ').trim();
  return [kind, who].filter(Boolean).join(' · ') || undefined;
}

/** A selected file name is one segment of `~/.ssh` — never a path out of it. */
const SSH_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The `~/.ssh` files that are settings rather than keys, so no `.pub` pairing. */
const SSH_NON_KEY = new Set(['config', 'known_hosts']);

/**
 * Options only Apple's OpenSSH understands. `UseKeychain` is the one that
 * matters: Apple's own documentation tells Mac users to put it in `~/.ssh/config`,
 * so it is in a great many of them.
 */
const MACOS_ONLY_SSH_OPTIONS = ['usekeychain'];

/**
 * Comment out the macOS-only options in a copied `~/.ssh/config`.
 *
 * Linux OpenSSH does not ignore an option it does not know — it refuses to
 * start: `Bad configuration option: usekeychain` / `terminating, 1 bad
 * configuration options`, for EVERY host, including the ones the option had
 * nothing to do with. So a Mac operator who ticks `config` gets an ssh that
 * cannot connect anywhere, and an error that names a line they wrote years ago
 * on the advice of Apple's documentation. (Found by running it, not by reading
 * about it.)
 *
 * Commented rather than deleted, with the reason inline: the file is the
 * operator's, and it shows up in a container they can read.
 */
export function sanitizeSshConfig(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const option = line.trim().split(/[\s=]+/)[0]?.toLowerCase() ?? '';
      if (!MACOS_ONLY_SSH_OPTIONS.includes(option)) return line;
      return `# ${line.trim()}  # cezar: macOS-only option, rejected by OpenSSH here`;
    })
    .join('\n');
}

/** A credential the operator defined themselves — a path, some env, or both. */
export interface CustomCredential {
  id: string;
  label?: string;
  hostPath?: string;
  guestPath?: string;
  env?: string[];
  mode?: PassthroughMode;
  /**
   * Where the VALUE comes from, when it is not already in the cockpit's own
   * environment — today `vault://<mount>/<path>#<field>`.
   *
   * The value is fetched on the host and injected; the container never gets the
   * credential that fetched it. Every name in `env` receives the same value,
   * which in practice is one name.
   */
  valueFrom?: string;
  /**
   * Fail the step when this secret cannot be resolved, instead of running
   * without it.
   *
   * Off by default, matching how a missing credential FILE is handled — skipped
   * with a reason. But a secret the task genuinely needs is different: absent,
   * the agent gets three tool calls into the work before failing at something
   * that names neither the secret nor Vault, so the operator can say "this one
   * is load-bearing" and get the honest error at the start.
   */
  required?: boolean;
}

/** What the operator chose for one catalog credential. */
export interface CredentialChoice {
  mode?: PassthroughMode;
  /**
   * For a `selectable` source: the individual files to pass, instead of the
   * whole directory. Empty or absent means the whole directory — which is what
   * every existing config says, so nothing changes underneath anyone.
   */
  keys?: string[];
}

export interface PassthroughSelection {
  /** Catalog ids that are on, with an optional mode override and file picks. */
  enabled?: Record<string, CredentialChoice | boolean>;
  /** Anything not in the catalog. */
  custom?: CustomCredential[];
}

/** Resolve `~`-relative catalog paths against the real home. */
export function hostPathOf(source: { hostPath?: string }, home = homedir()): string | undefined {
  if (!source.hostPath) return undefined;
  return source.hostPath.startsWith('/') ? source.hostPath : join(home, source.hostPath);
}

export interface ResolvedCredential {
  id: string;
  mode: PassthroughMode;
  /** Absent when the source is env-only, or the file simply is not there. */
  hostPath?: string;
  guestPath?: string;
  /** Env names to forward, with the value read from the host environment. */
  env: string[];
  /** Why it was skipped, when it was. */
  skipped?: string;
  /** Where the value must be fetched from, for a secret that is not on disk. */
  valueFrom?: string;
  /** Fail the step rather than run without it. */
  required?: boolean;
  /**
   * Modes to set inside the container after a copy. SSH refuses a private key
   * it considers world-readable ("UNPROTECTED PRIVATE KEY FILE") and simply
   * does not authenticate, so a copy that lands 0644 is a silent failure.
   */
  perms?: { file: string; dir: string };
  /** Rewrite the file's CONTENT on the way in; see `sanitizeSshConfig`. */
  sanitize?: 'ssh-config';
}

/**
 * Turn the selection into concrete work for the launcher.
 *
 * A selected credential whose file does not exist is SKIPPED with a reason
 * rather than mounted: podman would happily create an empty directory at that
 * path, and an empty `~/.aws` inside the container looks to every tool like
 * "logged out" — a far more confusing failure than "we did not find it".
 */
export function resolvePassthrough(
  selection: PassthroughSelection | undefined,
  home = homedir(),
  exists: (p: string) => boolean = existsSync,
): ResolvedCredential[] {
  const out: ResolvedCredential[] = [];
  if (!selection) return out;

  for (const source of CREDENTIAL_CATALOG) {
    const choice = selection.enabled?.[source.id];
    if (!choice) continue;
    // A single FILE is always copied, whatever mode was picked. A file bind mount
    // binds an inode, and the tools that own these files rewrite them by
    // temp-file-plus-rename (`gh auth login` and every token refresh do), which
    // strands the container on the deleted one — Claude's credential failed that
    // way after ~35 hours. And a mount is fixed when the container is created, so
    // ticking `gh` during a task did nothing until the next one; a copy reaches
    // the running container at once and is renewed every turn.
    const mode = source.kind === 'file'
      ? 'copy'
      : (typeof choice === 'object' && choice.mode) || source.defaultMode;
    const keys = typeof choice === 'object' ? choice.keys ?? [] : [];
    // A narrowed `selectable` source passes the named files instead of the
    // directory. This is the whole point of picking keys: the container gets
    // the deploy key it needs and not the one that reaches production.
    if (source.selectable === 'ssh' && keys.length > 0) {
      out.push(...resolveSshKeys(keys, home, exists, source.env ?? []));
      continue;
    }
    const hostPath = hostPathOf(source, home);
    const resolved: ResolvedCredential = {
      id: source.id,
      mode,
      guestPath: source.guestPath,
      env: source.env ?? [],
    };
    if (hostPath && exists(hostPath)) resolved.hostPath = hostPath;
    else if (hostPath) resolved.skipped = `${hostPath} does not exist on this machine`;
    out.push(resolved);
  }

  for (const custom of selection.custom ?? []) {
    const hostPath = custom.hostPath ? hostPathOf({ hostPath: custom.hostPath }, home) : undefined;
    const resolved: ResolvedCredential = {
      id: custom.id,
      mode: custom.mode ?? 'copy',
      guestPath: custom.guestPath,
      env: custom.env ?? [],
      ...(custom.valueFrom ? { valueFrom: custom.valueFrom } : {}),
      ...(custom.required ? { required: true } : {}),
    };
    const refused = hostPath ? refusedHostPath(hostPath, home) : undefined;
    if (refused) resolved.skipped = refused;
    else if (custom.guestPath !== undefined && !isGuestPath(custom.guestPath)) {
      resolved.skipped = `guest path ${JSON.stringify(custom.guestPath)} must be an absolute path without ':' or ','`;
    } else if (hostPath && exists(hostPath)) resolved.hostPath = resolvePath(hostPath);
    else if (hostPath) resolved.skipped = `${hostPath} does not exist on this machine`;
    out.push(resolved);
  }
  return out;
}

/**
 * One selected `~/.ssh` file becomes one COPIED credential.
 *
 * Always copy, never mount, whatever mode the source carries — for two reasons
 * that both point the same way:
 *
 *  - a key file is exactly the thing the module warns about mounting: static
 *    until something rewrites it (`ssh-keygen -p`, a rotation script), and a
 *    file bind mount does not survive that;
 *  - narrowing is a containment feature. "The container may use this key" and
 *    "the container may overwrite this key on my disk" are different grants,
 *    and someone ticking one key out of five is plainly asking for the first.
 *
 * A private key brings its `.pub` along when there is one. That is not a
 * widening — a public key is public — and some tooling still expects the pair.
 */
function resolveSshKeys(
  keys: string[],
  home: string,
  exists: (p: string) => boolean,
  env: string[],
): ResolvedCredential[] {
  const dir = join(home, '.ssh');
  const out: ResolvedCredential[] = [];
  const perms = { file: '600', dir: '700' };
  for (const name of keys) {
    // The name comes from config, which a person edits by hand. One segment,
    // no traversal: this string becomes both a host path and a guest path.
    if (!SSH_FILE.test(name)) continue;
    const hostPath = join(dir, name);
    const resolved: ResolvedCredential = {
      id: `ssh:${name}`,
      mode: 'copy',
      guestPath: `/root/.ssh/${name}`,
      env,
      perms,
      ...(name === 'config' ? { sanitize: 'ssh-config' as const } : {}),
    };
    if (exists(hostPath)) resolved.hostPath = hostPath;
    else resolved.skipped = `${hostPath} does not exist on this machine`;
    out.push(resolved);
    const pub = `${hostPath}.pub`;
    if (resolved.hostPath && !SSH_NON_KEY.has(name) && !name.endsWith('.pub') && exists(pub)) {
      out.push({
        id: `ssh:${name}.pub`,
        mode: 'copy',
        hostPath: pub,
        guestPath: `/root/.ssh/${name}.pub`,
        env: [],
        perms: { file: '644', dir: '700' },
      });
    }
  }
  return out;
}

/** `-v host:guest` arguments for the credentials that are MOUNTED. */
/** A podman named volume: no path separators, no option syntax. */
export function isVolumeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

/** An absolute container path that cannot carry `-v` option syntax (`:`, `,`) or climb (`..`). */
export function isGuestPath(value: string): boolean {
  return /^\/[^:,\0\n]*$/.test(value) && value.length <= 512 && !value.split('/').includes('..');
}

/**
 * Why a custom credential's host path is refused, or undefined when it is fine. A credential is a
 * credential — a file or a tool's config directory — never the filesystem root, the home
 * directory itself, or anything above it: those are "everything", which is exactly what isolation
 * withholds.
 */
export function refusedHostPath(hostPath: string, home: string): string | undefined {
  if (hostPath.includes(':') || hostPath.includes(',')) return `${hostPath} contains ':' or ','`;
  // Compared as the paths podman would mount: `.`/`..` collapsed (`/Users/k/.` IS the home) and
  // symlinks followed (a link to the home mounts the home).
  const target = canonicalPath(hostPath);
  const homeDir = canonicalPath(home);
  if (target === '/' || target === homeDir || homeDir.startsWith(`${target}/`)) {
    return `${hostPath} is not a credential — it would expose the whole home directory or more`;
  }
  return undefined;
}

/** `path` normalized, with symlinks resolved when it exists. */
function canonicalPath(path: string): string {
  const normalized = resolvePath(path);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

export function credentialMountArgs(resolved: ResolvedCredential[]): string[] {
  const args: string[] = [];
  for (const c of resolved) {
    if (c.mode !== 'mount' || !c.hostPath || !c.guestPath || c.skipped) continue;
    args.push('-v', `${c.hostPath}:${c.guestPath}`);
  }
  return args;
}

/** `podman cp` invocations for the credentials that are COPIED, in order. */
export function credentialCopyPlan(resolved: ResolvedCredential[], container: string): string[][] {
  const plan: string[][] = [];
  for (const c of resolved) {
    if (c.mode !== 'copy' || !c.hostPath || !c.guestPath || c.skipped) continue;
    plan.push(['cp', c.hostPath, `${container}:${c.guestPath}`]);
  }
  return plan;
}

/** One secret that could not be fetched, and why — for the run log and status. */
export interface SecretProblem {
  id: string;
  reason: string;
  /** The operator marked it load-bearing; the caller should fail the step. */
  required: boolean;
}

/**
 * Fetch the values of every credential that names a `valueFrom`, as `-e` pairs.
 *
 * Separate from `credentialEnvPairs` because this one is ASYNC: it talks to a
 * secret store. Keeping it out of the argv builders is what lets those stay
 * synchronous and pure, which is the property their tests rely on.
 *
 * A fetch that fails never yields an empty pair. An empty value SHADOWS a
 * credential the container already holds, so a failure is reported and the
 * variable is simply absent.
 */
export async function resolveSecretEnv(
  resolved: readonly ResolvedCredential[],
  fetch: (reference: string) => Promise<string>,
): Promise<{ pairs: string[]; problems: SecretProblem[] }> {
  const pairs: string[] = [];
  const problems: SecretProblem[] = [];
  for (const credential of resolved) {
    if (!credential.valueFrom) continue;
    let value: string;
    try {
      value = await fetch(credential.valueFrom);
    } catch (err) {
      problems.push({
        id: credential.id,
        reason: err instanceof Error ? err.message : String(err),
        required: credential.required === true,
      });
      continue;
    }
    if (value === '') {
      problems.push({
        id: credential.id,
        reason: `${credential.valueFrom} resolved to an empty value`,
        required: credential.required === true,
      });
      continue;
    }
    for (const name of credential.env) pairs.push(`${name}=${value}`);
  }
  return { pairs, problems };
}

/**
 * `GH_TOKEN=<token>` for a container whose project passes the GitHub CLI through, read on the
 * host by `readToken` (`gh auth token`, then `GITHUB_TOKEN`). The copied `hosts.yml` holds a
 * token only where gh stores it in the file — macOS's default is the Keychain. Nothing when the
 * GitHub CLI is not passed through, or when the host already exports a token (`credentialEnvPairs`
 * forwards that one). Never throws.
 */
export async function githubTokenEnv(
  resolved: readonly ResolvedCredential[],
  env: NodeJS.ProcessEnv,
  readToken: () => Promise<string | null>,
): Promise<string[]> {
  if (!resolved.some((c) => c.id === 'github-cli')) return [];
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return [];
  const token = await readToken().catch(() => null);
  return token ? [`GH_TOKEN=${token}`] : [];
}

/** `KEY=VALUE` pairs for every forwarded variable that is actually set. */
export function credentialEnvPairs(
  resolved: ResolvedCredential[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pairs: string[] = [];
  for (const c of resolved) {
    // A credential with a `valueFrom` is fetched, not read from the host env —
    // see `resolveSecretEnv`. Forwarding the host's value too would silently
    // prefer a stale local export over the store the operator pointed at.
    if (c.valueFrom) continue;
    for (const name of c.env) {
      const value = env[name];
      // Only forward what the host actually has. Passing an empty value would
      // SHADOW a credential the container already holds.
      if (value) pairs.push(`${name}=${value}`);
    }
  }
  return pairs;
}
