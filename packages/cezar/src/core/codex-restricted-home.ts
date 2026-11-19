import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, ftruncateSync, fchmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import type { AgentRunSpec } from './agent-runner.ts';
import { CODEX_DISABLED_FEATURES } from './codex-restricted-policy.ts';
import { CodexToolPolicyError } from './codex-tool-policy.ts';

// System and package-manager bins only (Homebrew, Linuxbrew, Nix); never a repo or worktree dir.
const SEALED_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/nix/var/nix/profiles/default/bin', '/run/current-system/sw/bin'].join(':');

const PROVIDER_KEYS = new Set(['name', 'base_url', 'wire_api', 'env_key', 'requires_openai_auth', 'http_headers', 'env_http_headers', 'query_params', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'supports_websockets']);
const AUTH_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'];
const CONTROL_ENV = /^(PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|USERPROFILE|APPDATA|SYSTEMROOT|CODEX_.*|NODE_.*|LD_.*|DYLD_.*|PYTHON.*|GIT_.*|GH_.*)$/i;

export interface RestrictedCodexHome {
  readonly path: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: Record<string, unknown>;
  readonly toolEnv: NodeJS.ProcessEnv;
  readonly githubReadsAllowed: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only model transport settings travel from the selected account. No instruction or execution config does. */
export function restrictedCodexModelConfig(text: string): { config: Record<string, unknown>; authEnv: string[] } {
  let root: Record<string, unknown>;
  try { root = record(parse(text)); } catch { throw new Error('codex: cannot parse the selected account config for restricted execution'); }
  const profile = typeof root.profile === 'string' ? record(record(root.profiles)[root.profile]) : {};
  const selected = { ...root, ...profile };
  const config: Record<string, unknown> = {};
  for (const key of ['model', 'model_provider', 'model_reasoning_effort']) {
    if (selected[key] !== undefined) {
      if (typeof selected[key] !== 'string') throw new Error(`codex: invalid isolated model setting ${key}`);
      config[key] = selected[key];
    }
  }
  const authEnv: string[] = [];
  if (typeof selected.model_provider === 'string' && selected.model_provider !== 'openai') {
    const name = selected.model_provider;
    const provider = record(record(selected.model_providers)[name]);
    if (!Object.keys(provider).length || Object.keys(provider).some(k => !PROVIDER_KEYS.has(k))) {
      throw new Error('codex: this model provider has settings unsupported by restricted execution');
    }
    for (const key of [provider.env_key, ...Object.values(record(provider.env_http_headers))]) {
      if (key === undefined) continue;
      if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || CONTROL_ENV.test(key)) {
        throw new Error('codex: model authentication cannot override isolated process controls');
      }
      authEnv.push(key);
    }
    config.model_providers = { [name]: provider };
  }
  return { config, authEnv };
}

function credentialLink(source: string, target: string): void {
  try {
    const current = lstatSync(target);
    if (!current.isSymbolicLink() || resolve(readlinkSync(target)) !== source) throw new Error('unexpected credential file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('codex: isolated credential link is invalid; refusing this session');
    if (existsSync(source)) symlinkSync(source, target, 'file');
  }
}

/** Separate state per account and working directory keeps restricted resumes away from native threads. */
export function prepareRestrictedCodexHome(
  spec: Pick<AgentRunSpec, 'cwd' | 'env'>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): RestrictedCodexHome {
  if (existsSync('/etc/codex') && readdirSync('/etc/codex').length) throw new CodexToolPolicyError('system Codex policies cannot be isolated');
  const inherited = { ...hostEnv, ...spec.env };
  const dry = hostEnv.CEZ_DRY_RUN === '1';
  const originalHome = inherited.HOME || homedir();
  const nativeHome = dry ? join(cezarHomeDir(hostEnv), 'codex-restricted-dry-source') : resolve(inherited.CODEX_HOME || join(originalHome, '.codex'));
  const cwd = realpathSync(spec.cwd);
  const key = createHash('sha256').update(`${nativeHome}\0${cwd}`).digest('hex').slice(0, 32);
  const directory = join(cezarHomeDir(hostEnv), 'codex-restricted', key);
  assertCezarHomeWriteIsSandboxed(directory, hostEnv);
  // No writable parent may be shared with the repository. This state is managed by cezar.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('codex: isolated state must not be symlinked');
  const path = realpathSync(directory);
  for (const name of ['rules', 'hooks', 'hooks.json', 'mcp.json', 'plugins', 'agents', 'managed_config.toml', 'requirements.toml']) {
    const item = join(path, name);
    if (existsSync(item) && (!lstatSync(item).isDirectory() || readdirSync(item).length)) throw new CodexToolPolicyError('unexpected execution settings in isolated Codex state');
  }
  const shellHome = join(path, 'shell-home');
  mkdirSync(shellHome, { recursive: true, mode: 0o700 });
  if (lstatSync(shellHome).isSymbolicLink()) throw new Error('codex: isolated shell home must not be symlinked');
  let text = '';
  try { text = readFileSync(join(nativeHome, 'config.toml'), 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const model = restrictedCodexModelConfig(text);
  const config: Record<string, unknown> = {
    ...model.config,
    cli_auth_credentials_store: 'file',
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    check_for_update_on_startup: false,
    agents: { enabled: false },
    features: Object.fromEntries(CODEX_DISABLED_FEATURES.map(key => [key, false])),
    projects: { [cwd]: { trust_level: 'untrusted' } },
    shell_environment_policy: { inherit: 'none', set: {
      HOME: shellHome, PATH: SEALED_PATH,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.pager', GIT_CONFIG_VALUE_1: 'cat',
      GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null',
      GIT_CONFIG_KEY_3: 'protocol.allow', GIT_CONFIG_VALUE_3: 'never',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_BROWSER: 'false',
      RIPGREP_CONFIG_PATH: '',
    } },
  };
  const configPath = join(path, 'config.toml');
  const configFd = openSync(configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(configFd).isFile()) throw new Error('codex: invalid isolated config file');
    fchmodSync(configFd, 0o600);
    ftruncateSync(configFd, 0);
    writeFileSync(configFd, stringify(config as Parameters<typeof stringify>[0]));
  } finally { closeSync(configFd); }
  credentialLink(join(nativeHome, 'auth.json'), join(path, 'auth.json'));
  // Build this environment from scratch: a host opt-in to full inheritance cannot widen it.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', ...(!dry ? AUTH_ENV : []), ...model.authEnv]) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  env.HOME = shellHome;
  env.USERPROFILE = shellHome;
  env.CODEX_HOME = path;
  env.SHELL = '/bin/sh';
  // Keep shell startup and XDG config out of the real account, including on machines with global XDG vars.
  env.XDG_CONFIG_HOME = join(shellHome, '.config');
  const ghHome = join(path, 'gh');
  mkdirSync(ghHome, { recursive: true, mode: 0o700 });
  if (lstatSync(ghHome).isSymbolicLink()) throw new Error('codex: isolated GitHub config must not be symlinked');
  const nativeGh = dry ? join(nativeHome, 'gh') : resolve(inherited.GH_CONFIG_DIR || join(inherited.XDG_CONFIG_HOME || join(originalHome, '.config'), 'gh'));
  credentialLink(join(nativeGh, 'hosts.yml'), join(ghHome, 'hosts.yml'));
  const shellEnv = record(record(config.shell_environment_policy).set) as Record<string, string>;
  const toolEnv: NodeJS.ProcessEnv = { ...shellEnv, GH_CONFIG_DIR: ghHome };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'LANG', 'LC_ALL']) {
    if (!dry && inherited[name] !== undefined) toolEnv[name] = inherited[name];
  }
  if (!dry && inherited.GH_HOST) for (const name of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    if (inherited[name] !== undefined) toolEnv[name] = inherited[name];
  }
  return { path, env, config, toolEnv, githubReadsAllowed: hostEnv.CEZ_CODEX_NETWORK !== '0' };
}
