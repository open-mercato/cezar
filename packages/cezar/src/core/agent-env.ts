/**
 * Least-privilege environment for spawned agent backends (#427).
 *
 * Every backend used to inherit the FULL parent environment
 * (`{ ...process.env, ...spec.env }`), handing `GITHUB_TOKEN`,
 * `ANTHROPIC_API_KEY`, `AWS_*` and any other host secret to a process an
 * attacker-controlled prompt can drive. Instead we build an explicit,
 * curated child env: a base allowlist of the non-secret vars a shell / dev
 * toolchain genuinely needs, plus the specific auth vars the chosen backend
 * requires, plus cezar's own `CEZ_*` namespace and the per-run `spec.env`.
 * Everything else — notably arbitrary secrets — is dropped by default.
 *
 * Zero-config: the safe env is the default and needs no configuration. Two
 * opt-in escape hatches (both read from the host env, both off by default):
 *   - `CEZ_ENV_PASSTHROUGH=A,B,C` forwards those extra named vars;
 *   - `CEZ_AGENT_ENV_FULL=1` restores the legacy full-`process.env` behavior.
 */

import type { AgentBackend } from './agent-runner.ts';
import { SECRET_NAME_RE } from './secret-redaction.ts';

/**
 * Env var names are matched case-INSENSITIVELY (#427 review). Windows spells
 * the essentials `Path`, `SystemRoot`, `ComSpec`, `windir` — an exact-case
 * `Set.has('PATH')` matched none of them, so every child env on win32 came out
 * with no PATH and the backend binary could not even be resolved. The child env
 * still carries each var under the parent's ORIGINAL spelling: Windows tooling
 * expects `Path`, and normalizing the key would break it just as badly.
 */
function upperSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((n) => n.toUpperCase()));
}

/** Exact var names always forwarded — non-secret, needed by shells/tools. */
const BASE_ALLOW_NAMES: ReadonlySet<string> = upperSet([
  // Core shell / process identity
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'HOSTNAME',
  'HOST',
  'HOSTTYPE',
  'MACHTYPE',
  'OSTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  // Locale
  'LANG',
  'LANGUAGE',
  // Terminal / display
  'TERM',
  'TERMINFO',
  'COLORTERM',
  'COLUMNS',
  'LINES',
  'CLICOLOR',
  'FORCE_COLOR',
  'NO_COLOR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  // ssh agent socket/pid — a path + pid, not a credential (git over ssh)
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  // Editors / pagers
  'EDITOR',
  'VISUAL',
  'PAGER',
  'LESS',
  'MANPATH',
  'INFOPATH',
  // Git plumbing that is not a secret
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_TERMINAL_PROMPT',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  // Proxies (matching is case-insensitive, so `http_proxy` is covered too)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  // Windows equivalents of the above. Without these `nodeSpawn('claude', …)`
  // cannot resolve or launch the binary at all on win32 — the platform is
  // supported (open-in-terminal.ts, open-in-app.ts, process-usage.ts) and
  // package.json carries no `os` restriction. `HOME` is normally unset there;
  // `USERPROFILE` is its counterpart.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'PSMODULEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'LOGONSERVER',
  'SESSIONNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
]);

/** Safe prefix families — dev toolchains that agents drive (node, python,
 *  rust, go, java, …). A name here still drops if it matches a secret
 *  pattern (e.g. `NODE_AUTH_TOKEN`, `CARGO_REGISTRY_TOKEN`). */
const BASE_ALLOW_PREFIXES: readonly string[] = [
  'LC_',
  'XDG_',
  'LESS_',
  // Node / JS
  'NODE_',
  'NPM_CONFIG_',
  'NVM_',
  'PNPM_',
  'YARN_',
  'BUN_',
  'DENO_',
  'VOLTA_',
  'FNM_',
  'COREPACK_',
  // Python
  'PYENV',
  'PYTHON',
  'PIP_',
  'PIPENV_',
  'POETRY_',
  'VIRTUAL_ENV',
  'CONDA_',
  'UV_',
  // Ruby
  'RBENV',
  'RUBY',
  'GEM_',
  'BUNDLE_',
  // Rust
  'RUSTUP_',
  'CARGO_',
  'RUST_',
  // Go
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'GOCACHE',
  'GOMODCACHE',
  'GOFLAGS',
  'GOPROXY',
  'GOPRIVATE',
  'GOTOOLCHAIN',
  'GOOS',
  'GOARCH',
  'GOENV',
  'GOWORK',
  'GO111MODULE',
  // JVM / Android / Kotlin
  'JAVA',
  'JDK_',
  'MAVEN_',
  'GRADLE_',
  'KOTLIN_',
  'ANDROID_',
  'SDKMAN_',
  // .NET / other
  'DOTNET_',
  'NUGET_',
  'SWIFT',
  'XCODE',
  'HOMEBREW_',
  'ASDF_',
  'MISE_',
  'COMPOSER_',
];

/** The provider credentials a backend that selects models as `provider/model` may need — it can
 *  be pointed at any of them, so none can be pruned without breaking a legitimate model id. */
const MULTI_PROVIDER_PREFIXES: readonly string[] = [
  'OPENAI_',
  'ANTHROPIC_',
  'AZURE_OPENAI_',
  'OPENROUTER_',
  'GROQ_',
  'MISTRAL_',
  'GEMINI_',
  'GOOGLE_GENERATIVE_AI_',
  'DEEPSEEK_',
  'XAI_',
  'PERPLEXITY_',
  'TOGETHER_',
  'FIREWORKS_',
];

/** Per-backend auth/config the runner genuinely needs, by prefix. */
const BACKEND_ALLOW_PREFIXES: Record<AgentBackend, readonly string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  'claude-cli': ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['OPENAI_', 'CODEX_', 'AZURE_OPENAI_'],
  opencode: MULTI_PROVIDER_PREFIXES,
  // pi selects models as `provider/model` (#387), so it needs both its own config and any
  // provider a configured model id can name — the same set OpenCode gets, for the same reason.
  // Deliberately NOT `CLAUDE_`: pi is not Claude Code and reads none of its variables, and the
  // prefix is load-bearing below — it is what unlocks the Bedrock/Vertex cloud credentials, so
  // granting it here handed pi the whole `AWS_*` / `GOOGLE_CLOUD_*` family on any host that had
  // set `CLAUDE_CODE_USE_BEDROCK=1` for Claude Code, plus Claude's own config dir.
  pi: ['PI_', ...MULTI_PROVIDER_PREFIXES],
};

/** `gh` handoff (draft PRs) works in every backend — the one credential the
 *  project deliberately keeps in the environment (AGENTS.md "No secrets in
 *  state files": GITHUB_TOKEN stays in env, never on disk). */
const GH_ALLOW_NAMES: ReadonlySet<string> = upperSet([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GH_CONFIG_DIR',
]);

/**
 * Claude Code can be pointed at Bedrock or Vertex instead of the Anthropic API
 * by `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1`. Those toggles
 * ride in on the `CLAUDE_` prefix — but the cloud credentials they switch the
 * SDK over to did not, so hardening the env forwarded the *instruction* to use
 * Bedrock while dropping the *means*, turning a working setup into a hard auth
 * failure with no hint (#427 review). Each toggle therefore unlocks exactly the
 * credentials its own path needs, and only while it is on: with no toggle set
 * (the default, direct-API posture) `AWS_*` / `GOOGLE_*` stay dropped, which is
 * the least-privilege behavior #427 asked for in the first place.
 */
const BEDROCK_TOGGLE = 'CLAUDE_CODE_USE_BEDROCK';
const VERTEX_TOGGLE = 'CLAUDE_CODE_USE_VERTEX';
/** The whole `AWS_` family: the SDK's credential chain reads far more than the
 *  static keys (SSO/profile/container/web-identity all have their own vars). */
const BEDROCK_ALLOW_PREFIXES: readonly string[] = ['AWS_'];
const VERTEX_ALLOW_NAMES: ReadonlySet<string> = upperSet([
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
  // ANTHROPIC_VERTEX_PROJECT_ID already rides in on the `ANTHROPIC_` prefix.
]);
const VERTEX_ALLOW_PREFIXES: readonly string[] = ['GOOGLE_CLOUD_'];

export function looksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** Prefixes are authored uppercase; `name` must already be normalized. */
function matchesPrefix(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => name.startsWith(p));
}

/** Case-insensitive read of `source` — a win32 fixture may spell it `Path`. */
function readVar(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(source)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

/** An opt-in toggle is on unless it is absent/empty/`0`/`false`. */
function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

export interface BuildChildEnvOptions {
  backend: AgentBackend;
  /** Per-run env (CEZ_HANDOFF_FILE etc.) — always applied, wins over host. */
  extraEnv?: Record<string, string>;
  /** Source env; defaults to `process.env`. */
  source?: NodeJS.ProcessEnv;
}

/**
 * Build the curated child environment for a spawned backend. `extraEnv`
 * (the runner's `spec.env`) is applied last so per-run vars always win.
 */
export function buildChildEnv(opts: BuildChildEnvOptions): NodeJS.ProcessEnv {
  const source = opts.source ?? process.env;
  const extra = opts.extraEnv ?? {};

  // Names `extra` is about to define, normalized. The host copy of a var the
  // per-run env overrides must be DROPPED, not merely shadowed: env names are
  // matched case-insensitively here (and by Windows itself), so a host `Temp`
  // and a per-run `TEMP` are the same variable spelled two ways — leaving both
  // in the child env hands the backend the host value under one of them. That
  // is exactly the temp-directory bug #785 fixes, so the override has to be
  // total. `extra` is cezar's own, never a host secret, and always wins.
  const overridden = upperSet(Object.keys(extra));

  // Escape hatch: restore legacy full-inheritance (opt-in, off by default).
  // Parsed with the same `isTruthy` the Bedrock/Vertex toggles use (#456
  // review) — an exact `=== '1'` made `CEZ_AGENT_ENV_FULL=true` silently do
  // nothing, which is a confusing way to fail open-vs-closed.
  if (isTruthy(readVar(source, 'CEZ_AGENT_ENV_FULL'))) {
    const full: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(source)) {
      if (!overridden.has(name.toUpperCase())) full[name] = value;
    }
    return { ...full, ...extra };
  }

  const backendPrefixes = BACKEND_ALLOW_PREFIXES[opts.backend] ?? BACKEND_ALLOW_PREFIXES.claude;
  const passthrough = upperSet(
    (readVar(source, 'CEZ_ENV_PASSTHROUGH') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Cloud auth is unlocked only by the toggle that needs it, and only for a
  // backend that is actually given the toggle (`CLAUDE_` prefix) to read.
  const claudeCloud = backendPrefixes.includes('CLAUDE_');
  const cloudPrefixes: string[] = [];
  const cloudNames = new Set<string>();
  if (claudeCloud && isTruthy(readVar(source, BEDROCK_TOGGLE))) {
    cloudPrefixes.push(...BEDROCK_ALLOW_PREFIXES);
  }
  if (claudeCloud && isTruthy(readVar(source, VERTEX_TOGGLE))) {
    cloudPrefixes.push(...VERTEX_ALLOW_PREFIXES);
    for (const n of VERTEX_ALLOW_NAMES) cloudNames.add(n);
  }

  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (overridden.has(name.toUpperCase())) continue; // the per-run value replaces it, whatever the spelling
    if (allow(name)) out[name] = value;
  }
  // Per-run env last — it is cezar's own, never a host secret, and must win.
  for (const [name, value] of Object.entries(extra)) out[name] = value;
  return out;

  /** `name` is matched normalized; the caller keeps the original spelling. */
  function allow(name: string): boolean {
    const key = name.toUpperCase();
    // cezar's own namespace (CEZ_DRY_RUN plumbing, mock hooks, run wiring).
    if (key.startsWith('CEZ_')) return true;
    // Backend auth + gh handoff + the cloud creds an active Bedrock/Vertex
    // toggle needs: forwarded even though they are secrets — the backend cannot
    // authenticate without them. They are still redacted before anything
    // reaches the on-disk NDJSON (see secret-redaction.ts).
    if (GH_ALLOW_NAMES.has(key)) return true;
    if (matchesPrefix(key, backendPrefixes)) return true;
    if (cloudNames.has(key) || matchesPrefix(key, cloudPrefixes)) return true;
    // Explicit opt-in passthrough.
    if (passthrough.has(key)) return true;
    // Base allowlist — exact names always, prefix families only when the name
    // is not itself credential-shaped (`NODE_AUTH_TOKEN` never rides in on
    // `NODE_`, in either spelling — looksSecret sees the normalized name).
    if (BASE_ALLOW_NAMES.has(key)) return true;
    if (matchesPrefix(key, BASE_ALLOW_PREFIXES) && !looksSecret(key)) return true;
    return false;
  }
}
