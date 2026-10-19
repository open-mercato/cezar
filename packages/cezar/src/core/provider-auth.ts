import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, isAbsolute } from 'node:path';
import { AGENT_MODELS_LOCKED_ENV } from './agent-model-policy.ts';
import { profileEnv } from './agent-profiles.ts';
import { isSignalTerminationExit } from './agent-runner.ts';
import { resolveClaudeBin } from './claude-bin.ts';
import { resolveCursorAgentBin } from './cursor-bin.ts';
import { quoteExecutable, withEnvPrefix } from './shell-env.ts';
import { probeJunieAuthentication } from './junie-auth-probe.ts';
import { spawnableCommand } from './windows-shim.ts';

export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-installed'
  | 'unknown';

export interface ProviderStatus {
  provider: ProviderId;
  status: ProviderConnectionState;
  enabled?: boolean;
  hint?: string;
  authFailureId?: string;
  /** Which agent account this row describes (spec 2026-07-29-agent-profiles). Absent on the rows
   *  `status()` builds — that route answers for the discovered default only, and stays exactly
   *  as wide as it has always been. Stamped in by `profileStatus()`. */
  profileId?: string;
}

export interface ProviderStatusResponse {
  providers: ProviderStatus[];
}

export interface ProviderCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
  timedOut?: boolean;
  /** The signal that killed the CLI, when one did and it was not cezar's own timeout. */
  signal?: string;
}

export type RunProviderCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  /** Extra environment for the probe — how an agent profile's config dir reaches the CLI (spec
   *  2026-07-29-agent-profiles). Optional so every existing caller and the test kit keep their
   *  three-argument signature; absent means the default profile, which needs nothing. */
  env?: Record<string, string>,
  /** Written to the probe's stdin, which is then closed. Only Copilot needs it: the CLI ships no
   *  non-interactive auth-status command, so its state is read by driving its ACP server. Optional
   *  so every existing caller and the test kit keep their shorter signature. */
  stdin?: string,
) => Promise<ProviderCommandResult>;

/**
 * The explicit environment lock delegates model and credential configuration
 * to each native coding agent. In that mode Cezar must not second-guess the
 * agent's own credentials through the provider checks introduced by #652.
 *
 * Config-file model locks intentionally do not disable the checks: this bypass
 * is an operator-level process policy and only the exact documented `1` opts in.
 */
export function providerAuthChecksDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[AGENT_MODELS_LOCKED_ENV] === '1';
}

interface ProviderDescriptor {
  id: ProviderId;
  executable: () => string;
  statusArgs: readonly string[];
  loginArgs: readonly string[];
  /** The CLI's own self-update, where it has one; others update the way they were installed. */
  updateArgs?: readonly string[];
  installHint: string;
  parse: (result: ProviderCommandResult) => ProviderConnectionState | null;
  /** See {@link RunProviderCommand}'s `stdin`. */
  stdin?: () => string;
  /**
   * An answer available WITHOUT spawning the CLI at all, checked before `runCommand` — `undefined`
   * defers to the normal probe. Every other backend's own CLI self-reports API-key vs. subscription
   * auth in its status command (codex literally prints "logged in using an API key"), so nothing
   * needs this. Cursor's `agent status` does not, which used to mean `CURSOR_API_KEY` support lived
   * ONLY inside `parseCursorStatus` — reachable when the command's own answer was inconclusive, but
   * never when the command hung: `probe()`'s `timedOut` branch returns before `parse()` runs, so a
   * status call that blocks on a network check (plausible with a key but no cached browser session)
   * silently ate the fallback and reported 'unknown' no matter how valid the key was. Skipping the
   * spawn entirely removes that race instead of racing to out-guess it.
   */
  precheck?: () => ProviderConnectionState | undefined;
  /** A more specific hint than "try again" for an answer `parse` could not read. */
  unrecognizedHint?: (result: ProviderCommandResult) => string | undefined;
  /** Arguments to ask once more with when `statusArgs` was rejected by an older CLI. */
  fallbackArgs?: (result: ProviderCommandResult) => readonly string[] | undefined;
  /** The `CEZ_*_BIN` override `executable` honours — only so a report can say the binary came from it. */
  overrideEnv: string;
}

const COMMAND_TIMEOUT_MS = 10_000;
/** A timed-out probe is asked once more with this budget: every CLI is probed at once, so a busy
 *  host (Windows, agents running) can stall them all past 10s together (telemetry e316b141). */
const RETRY_TIMEOUT_MS = 30_000;
/**
 * How long a probe result stands before it is re-checked — deliberately ASYMMETRIC.
 *
 * Which login an agent is signed into is operating knowledge: it matters for every run, and it
 * changes only when someone runs `claude auth login`. Re-probing it every few seconds cost a CLI
 * shell-out per provider and per account on every page load, for an answer that had almost
 * certainly not changed. So a CONNECTED answer is kept for minutes.
 *
 * A NOT-CONNECTED answer is re-checked sooner, for ONE reason: display self-healing. If you log in
 * from a terminal, cezar cannot see it happen, so a card that says "disconnected" must eventually
 * find out on its own. The window is a minute rather than seconds because reading is now
 * stale-while-revalidate (see `status`): every expiry costs a background probe, and a cockpit
 * polling this endpoint would turn a five-second window into a spawn every five seconds, forever,
 * on any machine where one provider is logged out — which is most of them.
 *
 * What this window is NOT is a correctness mechanism for starting runs. `provider-action-gate.ts`
 * refuses to start a run against a provider it believes disconnected, and it re-verifies before it
 * refuses (`providerActionError` in `server.ts`) rather than trusting an aging negative. That
 * inversion is what makes a long window safe here: the only reader that must not be wrong pays for
 * its own certainty, on the rare path where it is about to say no.
 *
 * A stale CONNECTED answer needs no window at all: the run starts, and a credential that really has
 * gone bad surfaces as a runtime auth failure, which is latched and overrides this cache on the spot
 * (`withRuntimeFailures`).
 *
 * Anything cezar CAN observe invalidates explicitly instead of waiting for either window: opening a
 * login (`POST /providers/connect`), repointing or removing an account (`forgetProfileStatus`), and
 * a runtime rejection.
 */
const CONNECTED_TTL_MS = 10 * 60_000;
const UNSETTLED_TTL_MS = 60_000;
/** How old a connected answer may be and still stand in for a probe that hung: a hang is no
 *  evidence of a logout, and turning it into `unknown` refused runs on a busy host (b28d2993). */
const TIMEOUT_BRIDGE_MS = 3 * CONNECTED_TTL_MS;

/**
 * How long before the same provider may be self-checked again after a runtime rejection
 * (`verifyRuntimeAuthFailure`).
 *
 * A latch is raised from a PATTERN MATCH on a runner's error text, and a single failing run can emit
 * several auth-shaped lines in a row. Without a floor, each line that re-latches after a successful
 * self-check would buy its own CLI spawn. One self-check a minute is plenty for the case this exists
 * for — a rejection that was transient against credentials that are still valid — and it bounds the
 * pathological case (a CLI that reports logged in while the vendor keeps rejecting the token) to one
 * probe per minute instead of one per error line.
 */
const RUNTIME_AUTH_VERIFY_COOLDOWN_MS = 60_000;

/** The lifetime for a set of rows: minutes only when EVERY row is connected. A mixed answer takes
 *  the short window, because the not-connected row in it is the one that might self-heal.
 *
 *  KNOWN COARSENESS: the window applies to the whole three-provider response, so one logged-out
 *  provider drags the two connected ones into re-probing with it. That is wasted work rather than a
 *  wrong answer, and it is now paid in the background; fixing it properly means per-provider
 *  timestamps and merging partial probe results. */
function cacheTtlFor(rows: readonly ProviderStatus[]): number {
  // Junie deliberately remains `unknown` after a successful handshake, so it must not force
  // every other provider's cached credential result onto the short negative-answer window.
  return rows.filter((row) => row.provider !== 'junie').every((row) => row.status === 'connected')
    ? CONNECTED_TTL_MS
    : UNSETTLED_TTL_MS;
}
const UNKNOWN_HINT = 'Authentication could not be verified. Try again.';
const TIMEOUT_HINT = 'Authentication check timed out. Try again.';
const INTERRUPTED_HINT = 'Authentication check was interrupted. Try again.';
const RUNTIME_AUTH_HINT =
  'Authentication was rejected during a run. Reconnect, then try again.';
const ANSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const RUNTIME_AUTH_FAILURE_PATTERNS = [
  /\b(?:failed to authenticate|authentication failed|unauthenticated|unauthorized)\b/i,
  /\bproviderautherror\b/i,
  /\b(?:oauth|access|refresh)?\s*token\b.{0,80}\b(?:revoked|expired|invalid)\b/i,
  /\b(?:revoked|expired|invalid)\b.{0,80}\b(?:oauth|access|refresh)?\s*token\b/i,
  /\b(?:oauth|token|credential|unauthorized|unauthenticated)\b.{0,80}\b401\b/i,
  /\b401\b.{0,80}\b(?:oauth|token|credential|unauthorized|unauthenticated)\b/i,
] as const;
const RUNTIME_API_KEY_FAILURE_PATTERNS = [
  // Vendor-shaped errors can carry a process prefix before the actual
  // authentication error, so anchor on that explicit error label.
  /\b(?:api|authentication|auth)\s*error\b\s*[:=-]\s*(?:(?:http\s+)?401\b[\s:=-]*)?(?:(?:revoked|expired|invalid)\s+(?:api[-\s]?key|x-api-key)|(?:api[-\s]?key|x-api-key)\s*(?:(?:is|was|has been)\s+|[:=-]\s*)?(?:revoked|expired|invalid))\b/i,
  // Otherwise require the credential rejection to be the complete line,
  // optionally introduced by a generic error label or 401 status. This keeps
  // implementation notes such as "coverage for invalid API key handling"
  // from looking like live authentication failures.
  /(?:^|\r?\n)\s*(?:error\s*[:=-]\s*)?(?:(?:http\s+)?401\b[\s:=-]*)?(?:(?:revoked|expired|invalid)\s+(?:api[-\s]?key|x-api-key)|(?:api[-\s]?key|x-api-key)\s+(?:(?:is|was|has been)\s+)?(?:revoked|expired|invalid))\s*(?:[.!]|$)/im,
] as const;

export function isRuntimeProviderAuthFailure(message: string): boolean {
  return [...RUNTIME_AUTH_FAILURE_PATTERNS, ...RUNTIME_API_KEY_FAILURE_PATTERNS]
    .some((pattern) => pattern.test(message));
}

function normalizedOutput(stdout: string): string {
  return stdout.replace(ANSI_SEQUENCE, '').trim().toLowerCase();
}

function normalizedLines(...outputs: string[]): string[] {
  return outputs.flatMap((output) => normalizedOutput(output).split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseClaudeStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  try {
    const value = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (value.loggedIn === true && result.exitCode === 0) return 'connected';
    if (value.loggedIn === false && result.exitCode === 1) return 'disconnected';
    return null;
  } catch {
    return null;
  }
}

function parseCodexStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  const answers = normalizedLines(result.stdout, result.stderr)
    .map((line): ProviderConnectionState | null => {
      if (
        line === 'logged in using chatgpt'
        || line === 'logged in using an api key'
        || line === 'logged in using agent identity'
        || line === 'logged in using access token'
        || line === 'logged in using personal access token'
        || line === 'logged in using amazon bedrock api key'
        || /^logged in using an api key - (?:\*{3}|\S{8}\*{3}\S{5})$/.test(line)
      ) {
        return 'connected';
      }
      if (line === 'not logged in' || line === 'run codex login to authenticate') {
        return 'disconnected';
      }
      return null;
    })
    .filter((answer): answer is ProviderConnectionState => answer !== null);
  if (answers.length !== 1) return null;
  if (answers[0] === 'connected' && result.exitCode === 0) return 'connected';
  if (answers[0] === 'disconnected' && result.exitCode === 1) return 'disconnected';
  return null;
}

function parseOpenCodeStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  if (result.exitCode !== 0) return null;
  const lines = normalizedLines(result.stdout);
  const storedSummaries = lines
    .map((line) => line.match(/^[^a-z0-9]*(\d+)\s+credentials?$/)?.[1])
    .filter((count): count is string => count !== undefined);

  // OpenCode 2.x replaced the summary with one row per stored credential, with the literal
  // `stored` state in the final column. Keep this shape deliberately narrow: a successful empty
  // response is the valid no-credentials answer, while any other output without either the 1.x
  // summary or 2.x rows remains inconclusive rather than being guessed as disconnected.
  if (storedSummaries.length === 0) {
    if (lines.length === 0) return 'disconnected';
    const storedRows = lines.filter((line) => /^.+\s{2,}.+\s+stored$/.test(line));
    return storedRows.length === lines.length && storedRows.length > 0 ? 'connected' : null;
  }
  if (storedSummaries.length !== 1) return null;
  const storedCount = Number(storedSummaries[0]);
  if (!Number.isSafeInteger(storedCount)) return null;

  const environmentSummaries = lines
    .map((line) => line.match(/^[^a-z0-9]*(\d+)\s+environment\s+variables?$/)?.[1])
    .filter((count): count is string => count !== undefined);
  const hasEnvironmentBlock = lines.some((line) => /^[^a-z0-9]*environment$/.test(line));
  if (environmentSummaries.length > 1) return null;
  if (hasEnvironmentBlock !== (environmentSummaries.length === 1)) return null;
  const environmentCount = environmentSummaries.length === 1
    ? Number(environmentSummaries[0])
    : 0;
  if (!Number.isSafeInteger(environmentCount)) return null;

  return storedCount > 0 || environmentCount > 0 ? 'connected' : 'disconnected';
}

/**
 * Dead code, on purpose: `probe()` special-cases `descriptor.id === 'junie'` and returns before
 * `descriptor.parse` is ever reached, because a real Auth CHECK requires driving the ACP
 * handshake itself (`initialize` → `authenticate` → `session/prompt`, confirmed live to be the
 * only path that actually surfaces "no usable entitlement") — this synchronous
 * execFile-and-regex probe has no seam for that. `junie --help`'s `Authentication:` section is
 * write-only (`--auth=<token>`, `--<provider>-api-key=<key>`) so there is no `auth status`-shaped
 * subcommand to parse in the first place. Kept only because `ProviderDescriptor.parse` is
 * required on every entry — this is the junie descriptor's metadata-only placeholder, not a
 * live code path.
 */
function parseJunieStatus(_result: ProviderCommandResult): ProviderConnectionState | null {
  return null;
}

function parsePiStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  if (result.exitCode !== 0) return null;
  const lines = normalizedLines(result.stdout);
  if (lines.some((line) => /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/.test(line))) {
    return 'connected';
  }
  if (
    lines.some((line) => line.includes('no models available'))
    && lines.some((line) => line.includes('/login'))
  ) {
    return 'disconnected';
  }
  return null;
}

/**
 * Copilot CLI has **no** non-interactive auth-status command — `login` is its only auth
 * subcommand and it is interactive (verified against 1.0.88;
 * `.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`). What it does have is an ACP
 * server that answers the question definitively and cheaply: `session/new` returns a `sessionId`
 * for an entitled credential and the JSON-RPC error `-32000 "Authentication required"` without
 * one. Nothing is prompted, so no AI credits are spent, and the server exits when stdin closes.
 */
function copilotAcpProbeStdin(): string {
  const initialize = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
  };
  // A throwaway cwd: the probe must not touch the user's repo, and `session/new` requires one.
  const newSession = { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: tmpdir(), mcpServers: [] } };
  return `${JSON.stringify(initialize)}\n${JSON.stringify(newSession)}\n`;
}

function parseCopilotStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  const output = `${result.stdout}\n${result.stderr}`;
  // Order matters: an authenticated answer also contains the `initialize` result, and an
  // unauthenticated one contains BOTH that result and the error, so the error is checked first.
  if (/"Authentication required"/i.test(output)) return 'disconnected';
  if (/"sessionId"\s*:\s*"/.test(output)) return 'connected';
  return null;
}

/** Telemetry 298c2e1f: a `copilot` that answered with no JSON-RPC frame never started an ACP
 *  server — an old Copilot CLI, or another program of that name (AWS Copilot) first on PATH. */
function copilotUnrecognizedHint(result: ProviderCommandResult): string | undefined {
  if (/"jsonrpc"\s*:/.test(`${result.stdout}\n${result.stderr}`)) return undefined;
  return 'The `copilot` command did not start GitHub Copilot CLI\'s ACP server. Update it with '
    + '`npm i -g @github/copilot`, or point CEZ_COPILOT_BIN at the GitHub Copilot CLI if another '
    + 'program named `copilot` comes first on PATH.';
}

const DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: 'claude',
    overrideEnv: 'CEZ_CLAUDE_BIN',
    executable: () => resolveClaudeBin(),
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login'],
    updateArgs: ['update'],
    installHint: 'Install Claude Code, then run `claude auth login`.',
    parse: parseClaudeStatus,
  },
  {
    id: 'codex',
    overrideEnv: 'CEZ_CODEX_BIN',
    executable: () => process.env.CEZ_CODEX_BIN ?? 'codex',
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    installHint: 'Install the Codex CLI, then run `codex login`.',
    parse: parseCodexStatus,
  },
  {
    id: 'opencode',
    overrideEnv: 'CEZ_OPENCODE_BIN',
    executable: () => process.env.CEZ_OPENCODE_BIN ?? 'opencode',
    statusArgs: ['auth', 'list'],
    loginArgs: ['auth', 'login'],
    updateArgs: ['upgrade'],
    installHint: 'Install OpenCode, then run `opencode auth login`.',
    parse: parseOpenCodeStatus,
  },
  {
    id: 'cursor',
    overrideEnv: 'CEZ_CURSOR_AGENT_BIN',
    executable: () => resolveCursorAgentBin(),
    statusArgs: ['status', '--format', 'json'],
    fallbackArgs: cursorFallbackArgs,
    unrecognizedHint: cursorUnrecognizedHint,
    loginArgs: ['login'],
    updateArgs: ['update'],
    installHint:
      'Install the Cursor CLI (`curl https://cursor.com/install -fsS | bash`), then run `agent login` (or set CURSOR_API_KEY).',
    parse: parseCursorStatus,
    // `agent status` doesn't itself know about CURSOR_API_KEY — see the `precheck` field's doc.
    precheck: () => (process.env.CURSOR_API_KEY?.trim() ? 'connected' : undefined),
  },
  {
    id: 'pi',
    overrideEnv: 'CEZ_PI_BIN',
    executable: () => process.env.CEZ_PI_BIN ?? 'pi',
    statusArgs: ['--list-models'],
    loginArgs: ['/login'],
    installHint: 'Install pi, then run `pi /login`.',
    parse: parsePiStatus,
  },
  {
    id: 'junie',
    overrideEnv: 'CEZ_JUNIE_BIN',
    executable: () => process.env.CEZ_JUNIE_BIN ?? 'junie',
    statusArgs: [],
    loginArgs: [],
    installHint: 'Install Junie (https://junie.jetbrains.com/cli), then run `junie` once and log in.',
    parse: parseJunieStatus,
  },
  {
    id: 'copilot',
    overrideEnv: 'CEZ_COPILOT_BIN',
    executable: () => process.env.CEZ_COPILOT_BIN ?? 'copilot',
    // `--no-auto-update`, as the runner passes: a status check must not download a CLI, nor run a
    // cached newer package than the one a run will launch (telemetry 298c2e1f).
    statusArgs: ['--acp', '--no-auto-update'],
    loginArgs: ['login'],
    installHint: 'Install GitHub Copilot CLI (`npm i -g @github/copilot`), then run `copilot login`.',
    parse: parseCopilotStatus,
    stdin: copilotAcpProbeStdin,
    unrecognizedHint: copilotUnrecognizedHint,
  },
];

function parseCursorStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  // probe() already handles ENOENT / any other errorCode before calling parse() — result here
  // always ran successfully at the process level. It also never reaches this function at all when
  // CURSOR_API_KEY is set (the cursor descriptor's `precheck` answers first), so this is purely
  // the `agent login` (browser OAuth) read.
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>;
      if (row.isAuthenticated === true || row.status === 'authenticated') return 'connected';
      if (row.isAuthenticated === false || row.status === 'unauthenticated') return 'disconnected';
    }
  } catch {
    /* fall through */
  }
  // The plain `status` answer of a CLI without `--format` (`cursorFallbackArgs`).
  if (result.exitCode === 0) {
    const lines = normalizedLines(result.stdout, result.stderr);
    // Tolerate a status glyph, "you are", "signed" and trailing punctuation across CLI releases.
    const connected = lines.some((line) => /^(?:[✓✔]\s*)?(?:logged|signed) in as\b/.test(line));
    const disconnected = lines.some((line) =>
      /^(?:[✗✕×✘!]\s*)?(?:you are |you're )?not (?:logged|signed) in\b(?! as\b)/.test(line));
    if (connected !== disconnected) return connected ? 'connected' : 'disconnected';
  }
  // Malformed or unrecognized JSON is inconclusive, not a confirmed unauthenticated state —
  // return null so probe() reports 'unknown' instead of telling the user to reconnect an
  // account that was never actually checked.
  return null;
}

/**
 * Cursor CLIs before `status --format` (≤ 2026.01.28, verified) reject it with exit 1
 * (telemetry 8d304c50, 1cd541cc). Match any parser's wording, not just commander's.
 */
const REJECTED_FORMAT_FLAG =
  /\b(?:unknown|unrecognized|unexpected|invalid)\b[^\n]*\b(?:option|argument|flag)s?\b[^\n]*?['"`]?(?:--)?format\b/i;

function cursorFallbackArgs(result: ProviderCommandResult): readonly string[] | undefined {
  if (result.exitCode === 0) return undefined;
  return REJECTED_FORMAT_FLAG.test(`${result.stderr}\n${result.stdout}`) ? ['status'] : undefined;
}

/** Telemetry 8d304c50: an `agent` that answers neither shape is likely another program of that name. */
function cursorUnrecognizedHint(result: ProviderCommandResult): string | undefined {
  if (result.stdout.trim()) return undefined;
  return 'The Cursor CLI did not answer its status check. Update it with `cursor-agent update`, or point '
    + 'CEZ_CURSOR_AGENT_BIN at Cursor\'s `cursor-agent` if another program named `agent` comes first on PATH.';
}

function defaultRunProviderCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
  stdin?: string,
): Promise<ProviderCommandResult> {
  // A Windows `.cmd` shim runs as `node <script>`: execFile throws EINVAL on the shim (a330744e).
  const [file, argv] = spawnableCommand(executable, args);
  return new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        // Inherit, then override: an auth probe is a short read-only CLI call, not a spawned
        // agent, so it does not go through `buildChildEnv`'s allowlist — the CLI still needs the
        // host's PATH and HOME to run at all. `env` is only ever a profile's config-dir variable.
        ...(env && Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout, stderr) => {
        const commandError = error as (NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string | null;
        }) | null;
        const code = commandError?.code;
        const timedOut = commandError?.code === 'ETIMEDOUT'
          || (commandError?.killed === true && commandError.signal === 'SIGTERM');
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: typeof code === 'number' ? code : error ? null : 0,
          errorCode: typeof code === 'string' ? code : undefined,
          timedOut,
          ...(!timedOut && commandError?.signal ? { signal: commandError.signal } : {}),
        });
      },
    );
    // Closing stdin is what makes a stdin-driven probe terminate at all: the Copilot ACP server
    // reads until EOF. A probe with no payload closes it immediately, exactly as before.
    child.stdin?.end(stdin ?? '');
  });
}

/** The per-account cache key. ONE definition: a probe that wrote under a different spelling than
 *  a peek reads would silently make every peek a miss, and every page load pay for a CLI spawn. */
function profileCacheKey(provider: ProviderId, profileId: string): string {
  return `${provider}\u0000${profileId}`;
}

function descriptorFor(provider: ProviderId): ProviderDescriptor {
  const descriptor = DESCRIPTORS.find(({ id }) => id === provider);
  if (!descriptor) throw new Error(`Unknown provider: ${provider}`);
  return descriptor;
}

interface RuntimeAuthFailure {
  generation: number;
  authFailureId: string;
}

/** One authoritative runtime authentication incident. The identifier is opaque
 * and stable until the user explicitly acknowledges that exact incident. */
export interface RuntimeAuthFailureReport {
  status: ProviderStatus & {
    status: 'disconnected';
    authFailureId: string;
  };
  /** True only for the global latch edge, so callers can fan out one coarse
   * status update while every affected task still records its own callout. */
  transitioned: boolean;
}

/** Why a CLI status probe ended `unknown` — a closed set, so a report can group on it. */
export type InconclusiveProbeReason =
  | 'spawn_threw'
  | 'spawn_error'
  | 'timeout'
  | 'unexpected_exit'
  | 'unrecognized_output';

/**
 * What an inconclusive probe can tell telemetry without its output: the shape of what came back
 * and how the binary was found. Never stdout/stderr text or a path — the CLI's output can carry an
 * account email or a token.
 */
export interface InconclusiveProbe {
  provider: ProviderId;
  reason: InconclusiveProbeReason;
  profile: 'default' | 'named';
  /** `override` (a `CEZ_*_BIN`), `absolute` (a resolved install location) or `path` (a bare name). */
  binSource: 'override' | 'absolute' | 'path';
  /** The executable's extension from a closed set: `.exe`, `.cmd`, …, `none` or `other`. */
  binExt: string;
  errorCode: string | null;
  exitCode: number | null;
  stdoutBytes: number;
  stdoutJson: boolean;
  stderrBytes: number;
  /** The CLI's own `--version`, as a bare semver; one extra spawn, paid only by a caller that
   *  is going to send the report. */
  cliVersion: () => Promise<string | null>;
}

const BIN_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.com', '.ps1', '.js', '.mjs', '.cjs', '.sh']);
const VERSION_TIMEOUT_MS = 5_000;

function binExtension(executable: string): string {
  const ext = extname(executable).toLowerCase();
  if (!ext) return 'none';
  return BIN_EXTENSIONS.has(ext) ? ext : 'other';
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// asdf, mise, pyenv/rbenv/nodenv-style shims answering for a command no active version provides.
const SHIM_MISS_PATTERNS = [
  /\bNo (?:version is set|preset version installed|versions set) for (?:command |shim: )?\S+/i,
  /\bTools? not installed for shim: \S+/i,
  /\S+ is not a valid shim\b/i,
  /^[a-z]+env: \S+: command not found$/im,
];

/**
 * The shim's own line when the command on PATH is a version-manager shim with nothing behind it
 * (telemetry f67df9d2: an asdf `pi` for Python 3.11.9). Nothing can run, so that is not-installed,
 * not an inconclusive auth check. Only a failed exit counts: a real answer is never re-read.
 */
export function versionManagerShimMiss(result: ProviderCommandResult): string | null {
  if (result.exitCode === 0 || result.exitCode === null) return null;
  const output = `${result.stderr}\n${result.stdout}`;
  for (const pattern of SHIM_MISS_PATTERNS) {
    const match = output.match(pattern);
    if (match) return match[0].trim().slice(0, 160);
  }
  return null;
}

/**
 * A probe stopped by a signal from outside — Ctrl-C reaches the whole foreground process group, so
 * the CLI exits 130 while cezar shuts down (telemetry ce0c5d1f). Says nothing about the CLI.
 */
function wasInterrupted(result: ProviderCommandResult): boolean {
  return !result.timedOut && (result.signal !== undefined || isSignalTerminationExit(result.exitCode));
}

function isSilentSuccess(result: ProviderCommandResult): boolean {
  return result.exitCode === 0 && !result.errorCode && !result.timedOut
    && result.stdout.trim() === '' && result.stderr.trim() === '';
}

/** The first semver in a `--version` answer; anything else in it is dropped. */
export function cliVersionFrom(output: string): string | null {
  // `v` optional: AWS Copilot answers `copilot version: v1.34.1`, which `\b` alone never matched.
  return output.match(/(?<![\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,24})?)/)?.[1] ?? null;
}

export class ProviderAuthService {
  private readonly runCommand: RunProviderCommand;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly createAuthFailureId: () => string;
  private readonly probeJunie: () => Promise<{ connected: boolean; hint?: string; notInstalled?: boolean }>;
  private readonly onInconclusive?: (probe: InconclusiveProbe) => void;
  /** Once per provider, reason and account kind per process: the background re-check runs every
   *  minute while a provider is logged out, and one broken install must not become a report a minute. */
  private readonly reportedInconclusive = new Set<string>();
  private readonly runtimeFailures = new Map<ProviderId, RuntimeAuthFailure>();
  /** Named-account incidents, keyed by `profileCacheKey`; the default login uses `runtimeFailures`. */
  private readonly profileRuntimeFailures = new Map<string, RuntimeAuthFailure>();
  /** One self-check at a time per provider, and not more often than the cooldown. Both guard the
   *  same thing — a CLI spawn per auth-shaped error line — from the two directions it can arrive
   *  from: concurrently, and in quick succession. */
  private readonly verifyingRuntimeFailures = new Set<ProviderId>();
  private readonly lastRuntimeVerification = new Map<ProviderId, number>();
  private nextRuntimeFailureGeneration = 0;
  private nextProbeGeneration = 0;
  private completed?: {
    response: ProviderStatusResponse;
    timestamp: number;
    generation: number;
  };
  private inFlight?: {
    raw: Promise<ProviderStatusResponse>;
    visible: Promise<ProviderStatusResponse>;
  };
  /** Per-account probe results, keyed by `profileCacheKey` (spec 2026-07-29-agent-profiles).
   *  Separate from `completed` because a second Claude login is a different answer to the same
   *  question, and sharing one slot would let whichever probe ran last speak for both. */
  private readonly completedProfiles = new Map<string, { status: ProviderStatus; timestamp: number }>();
  private readonly inFlightProfiles = new Map<string, Promise<ProviderStatus>>();
  /** The last probe that answered connected, keyed by provider (default login) or `profileCacheKey`;
   *  only {@link bridgeTimeout} reads it. */
  private readonly lastConnected = new Map<string, { status: ProviderStatus; at: number; configDir: string | null }>();

  constructor(options?: {
    runCommand?: RunProviderCommand;
    now?: () => number;
    platform?: NodeJS.Platform;
    createAuthFailureId?: () => string;
    /** Working directory the junie ACP probe opens its session in. Defaults to `process.cwd()`,
     *  but the server passes the boot project root so this agrees with the model catalog's own
     *  discovery cwd (`server.ts`'s `bootRoot`) instead of silently diverging from it. */
    cwd?: string;
    probeJunie?: () => Promise<{ connected: boolean; hint?: string; notInstalled?: boolean }>;
    /** Told when a CLI probe ends `unknown`, at most once per provider/reason/account kind. */
    onInconclusive?: (probe: InconclusiveProbe) => void;
  }) {
    this.onInconclusive = options?.onInconclusive;
    this.runCommand = options?.runCommand ?? defaultRunProviderCommand;
    this.now = options?.now ?? Date.now;
    this.platform = options?.platform ?? process.platform;
    this.createAuthFailureId = options?.createAuthFailureId ?? randomUUID;
    // Bounded to the SAME budget every other provider's status probe respects (#M2 review) — the
    // discovery module's own 15s default exists for the explicit "Check again" / model-picker
    // path, not for a status read that runs on every poll and warm-up.
    this.probeJunie = options?.probeJunie
      ?? (() => probeJunieAuthentication({ cwd: options?.cwd ?? process.cwd(), timeoutMs: COMMAND_TIMEOUT_MS }));
  }

  /**
   * Every provider's authentication state — STALE-WHILE-REVALIDATE, the same policy the health
   * snapshot uses.
   *
   * Once anything is known, a reader gets it immediately and an expired cache is refreshed BEHIND
   * the answer instead of in front of it. Awaiting the refresh is what made `GET
   * /providers/status` cost ~0.8s here (and ~3s on a slower box) every time the window lapsed:
   * the endpoint is read by the cockpit on a poll, so "occasionally slow" means "slow in the UI,
   * unpredictably". Only a genuinely cold cache waits, and after the boot warm there isn't one.
   *
   * `refresh: true` still blocks — it is what "Check again", `POST /providers/connect` and the
   * action gate's verify-before-refuse use, and they are asking precisely because they need an
   * answer that is true NOW.
   */
  status(options?: { refresh?: boolean }): Promise<ProviderStatusResponse> {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) {
      return Promise.resolve({
        providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })),
      });
    }

    if (options?.refresh) {
      // Joining a probe already running satisfies "true now" and preserves the in-flight identity
      // contract (one shared promise for concurrent callers).
      return this.inFlight ? this.inFlight.visible : this.startFreshProbe().visible;
    }
    if (this.completed) {
      // Checked BEFORE `inFlight` on purpose: a reader arriving during a background revalidation
      // must be served from cache, not attached to the probe it was meant to avoid.
      if (this.now() - this.completed.timestamp >= cacheTtlFor(this.completed.response.providers)) {
        if (!this.inFlight) void this.startFreshProbe().raw.catch(() => {});
      }
      return Promise.resolve(this.withRuntimeFailures(this.completed.response));
    }
    if (this.inFlight) return this.inFlight.visible;
    return this.startFreshProbe().visible;
  }

  reportRuntimeAuthFailure(provider: ProviderId): RuntimeAuthFailureReport | null {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return null;
    const current = this.runtimeFailures.get(provider);
    const failure: RuntimeAuthFailure = {
      generation: ++this.nextRuntimeFailureGeneration,
      authFailureId: current?.authFailureId ?? this.createAuthFailureId(),
    };
    this.runtimeFailures.set(provider, failure);
    this.lastConnected.delete(provider);
    return {
      status: {
        provider,
        status: 'disconnected',
        hint: RUNTIME_AUTH_HINT,
        authFailureId: failure.authFailureId,
      },
      transitioned: current === undefined,
    };
  }

  /**
   * A runtime rejection on a NAMED agent account (telemetry 9e4a95db): latched on that account only.
   * Raising the provider-wide latch instead blamed the default login, which was still signed in.
   * Lifts when a probe of this account that started after the rejection answers connected — the
   * pane's Check again, Connect's watch, or the action gate's verify-before-refuse.
   */
  reportProfileAuthFailure(provider: ProviderId, profileId: string): RuntimeAuthFailureReport | null {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return null;
    const key = profileCacheKey(provider, profileId);
    const current = this.profileRuntimeFailures.get(key);
    const failure: RuntimeAuthFailure = {
      generation: ++this.nextRuntimeFailureGeneration,
      authFailureId: current?.authFailureId ?? this.createAuthFailureId(),
    };
    this.profileRuntimeFailures.set(key, failure);
    this.lastConnected.delete(key);
    return {
      status: {
        provider,
        status: 'disconnected',
        hint: RUNTIME_AUTH_HINT,
        authFailureId: failure.authFailureId,
        profileId,
      },
      transitioned: current === undefined,
    };
  }

  private withProfileFailure(status: ProviderStatus, profileId: string): ProviderStatus {
    const failure = this.profileRuntimeFailures.get(profileCacheKey(status.provider, profileId));
    return failure
      ? { provider: status.provider, status: 'disconnected', hint: RUNTIME_AUTH_HINT, authFailureId: failure.authFailureId, profileId }
      : status;
  }

  /** Clear only the incident the caller actually observed. A stale retry must
   * never erase a rejection that arrived after the user began recovery. */
  clearRuntimeAuthFailure(provider: ProviderId, authFailureId: string): boolean {
    const current = this.runtimeFailures.get(provider);
    if (!current || current.authFailureId !== authFailureId) return false;
    this.runtimeFailures.delete(provider);
    return true;
  }

  /**
   * Ask the provider's OWN CLI whether a runtime rejection was real, and drop the incident when it
   * was not. Resolves to the recovered row when it cleared one, `null` otherwise.
   *
   * A latch is raised by matching a runner's error text against
   * {@link isRuntimeProviderAuthFailure} — a heuristic over vendor prose — and it then outranks every
   * probe (`withRuntimeFailures`). Before this existed, `clearRuntimeAuthFailure` had exactly one
   * caller, `POST /providers/:provider/retry`, so the only way out of a latch was a human opening
   * Settings and pressing "Try again". That button clears the incident and re-probes, and it works,
   * which is the whole diagnosis: the credentials were still there. A transient 401 and a false
   * positive of the text match were both indistinguishable from a real logout, and both parked the
   * cockpit until someone clicked.
   *
   * So the latch stays authoritative — it is raised instantly, and `provider-action-gate` keeps
   * refusing to start runs against it — but it no longer stands unexamined. This is deliberately the
   * same two steps the retry route performs, minus the human: probe, then clear.
   *
   * What it will NOT do:
   * - clear an incident it did not observe. The id is captured before the probe and handed to
   *   `clearRuntimeAuthFailure`, so a rejection that arrives mid-probe survives the answer to an
   *   older question.
   * - clear on anything but `connected`. `disconnected`, `not-installed` and `unknown` all leave the
   *   latch alone; an inconclusive probe is not evidence of health.
   * - spawn more than one probe per provider per {@link RUNTIME_AUTH_VERIFY_COOLDOWN_MS}.
   */
  async verifyRuntimeAuthFailure(provider: ProviderId): Promise<ProviderStatus | null> {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return null;
    const failure = this.runtimeFailures.get(provider);
    if (!failure) return null;
    if (this.verifyingRuntimeFailures.has(provider)) return null;
    const lastVerifiedAt = this.lastRuntimeVerification.get(provider);
    if (lastVerifiedAt !== undefined && this.now() - lastVerifiedAt < RUNTIME_AUTH_VERIFY_COOLDOWN_MS) {
      return null;
    }

    this.verifyingRuntimeFailures.add(provider);
    let probed: ProviderStatus;
    try {
      this.lastRuntimeVerification.set(provider, this.now());
      probed = await this.probe(descriptorFor(provider));
    } finally {
      this.verifyingRuntimeFailures.delete(provider);
    }

    if (probed.status !== 'connected') return null;
    if (!this.clearRuntimeAuthFailure(provider, failure.authFailureId)) return null;
    this.rememberProbedRow(probed);
    return probed;
  }

  /**
   * Fold ONE freshly probed row into the cached response.
   *
   * Without this, dropping a latch would uncover whatever the last full probe happened to say about
   * that provider — which can be older than the answer we just got, and on a cold-ish cache can be
   * `unknown`. Clearing an incident only to reveal a stale contradiction would trade a red banner for
   * a grey one. The cache TIMESTAMP is deliberately untouched: this corrects one row, it is not a
   * full probe, and it must not extend the whole response's lifetime.
   */
  private rememberProbedRow(status: ProviderStatus): void {
    if (!this.completed) return;
    this.completed = {
      ...this.completed,
      response: {
        providers: this.completed.response.providers.map((row) => (
          row.provider === status.provider ? status : row
        )),
      },
    };
  }

  /**
   * The command that logs `provider` in, as a copyable one-liner.
   *
   * `configDir` points the login at a specific agent account (spec 2026-07-29-agent-profiles) —
   * without it, "Connect" on a second Claude account would sign the user into the FIRST one and
   * report success. Returns `null` when the dir cannot be embedded safely on this platform, and
   * the caller must then refuse rather than fall back to the bare command: a login aimed at the
   * wrong account is the failure this whole path exists to prevent.
   */
  loginCommand(provider: ProviderId, configDir?: string | null): string | null {
    const descriptor = descriptorFor(provider);
    const command = [quoteExecutable(descriptor.executable(), this.platform), ...descriptor.loginArgs].join(' ');
    const env = configDir ? profileEnv(provider, configDir) : {};
    return withEnvPrefix(command, env, this.platform);
  }

  /** The agent CLI's self-update command (`opencode upgrade`), or null when it has none. */
  updateCommand(provider: ProviderId): string | null {
    const descriptor = descriptorFor(provider);
    if (!descriptor.updateArgs) return null;
    return [quoteExecutable(descriptor.executable(), this.platform), ...descriptor.updateArgs].join(' ');
  }

  installHint(provider: ProviderId): string {
    return descriptorFor(provider).installHint;
  }

  private withRuntimeFailures(response: ProviderStatusResponse): ProviderStatusResponse {
    if (this.runtimeFailures.size === 0) return response;
    return {
      providers: response.providers.map((row) => {
        const failure = this.runtimeFailures.get(row.provider);
        return failure
          ? {
            provider: row.provider,
            status: 'disconnected',
            hint: RUNTIME_AUTH_HINT,
            authFailureId: failure.authFailureId,
          }
          : row;
      }),
    };
  }

  private startFreshProbe(): {
    raw: Promise<ProviderStatusResponse>;
    visible: Promise<ProviderStatusResponse>;
  } {
    const generation = ++this.nextProbeGeneration;
    const raw = Promise.all(DESCRIPTORS.map((descriptor) => this.probe(descriptor)))
      .then((probed) => {
        const response = { providers: probed.map((row) => this.bridgeTimeout(row.provider, row)) };
        if (!this.completed || generation >= this.completed.generation) {
          this.completed = { response, timestamp: this.now(), generation };
        }
        return response;
      });
    // One derived visible promise per raw probe preserves the historical
    // in-flight identity contract while still consulting the current latch
    // only after the async vendor commands resolve.
    const probe = {
      raw,
      visible: raw.then((response) => this.withRuntimeFailures(response)),
    };
    this.inFlight = probe;
    void raw.finally(() => {
      if (this.inFlight === probe) this.inFlight = undefined;
    });
    return probe;
  }

  /**
   * One NON-default agent account's authentication state (spec 2026-07-29-agent-profiles).
   *
   * Deliberately a separate entry point from `status()`, which keeps answering exactly one row
   * per provider — the discovered default — so `GET /api/v1/providers/status` is byte-identical
   * for anyone with no extra accounts. Per-account rows are carried by the agent-profiles route.
   *
   * Cached on the same asymmetric lifetime as `status()` (`cacheTtlFor`: minutes for a connected
   * answer, a minute for anything else), keyed by `(provider, profileId)` so two Claude accounts never read
   * each other's answer. The provider-wide runtime latch is deliberately NOT applied — it belongs
   * to the default login; this account's own incident (`reportProfileAuthFailure`) is.
   */
  async profileStatus(
    provider: ProviderId,
    profile: { id: string; configDir: string | null },
  ): Promise<ProviderStatus> {
    if (process.env.CEZ_DRY_RUN === '1') {
      return { provider, status: 'connected', profileId: profile.id };
    }
    const key = profileCacheKey(provider, profile.id);
    const cached = this.completedProfiles.get(key);
    if (cached && this.now() - cached.timestamp < cacheTtlFor([cached.status])) {
      return this.withProfileFailure(cached.status, profile.id);
    }
    const pending = this.inFlightProfiles.get(key);
    if (pending) return pending.then((status) => this.withProfileFailure(status, profile.id));
    // A probe already running when a rejection arrived must not clear it (same rule as the default).
    const startedAt = this.nextRuntimeFailureGeneration;
    const probe = this.probe(descriptorFor(provider), profile.configDir)
      .then((status) => {
        const stamped = this.bridgeTimeout(key, { ...status, profileId: profile.id }, profile.configDir);
        this.completedProfiles.set(key, { status: stamped, timestamp: this.now() });
        const failure = this.profileRuntimeFailures.get(key);
        // The FRESH answer only: a bridged hang is not evidence that the rejection was transient.
        if (failure && failure.generation <= startedAt && status.status === 'connected') {
          this.profileRuntimeFailures.delete(key);
        }
        return this.withProfileFailure(stamped, profile.id);
      })
      .finally(() => {
        if (this.inFlightProfiles.get(key) === probe) this.inFlightProfiles.delete(key);
      });
    this.inFlightProfiles.set(key, probe);
    return probe;
  }

  /**
   * Drop a cached per-account answer — used when an account's dir changes under us.
   *
   * TARGETED by default, because this cache is warmed at boot and is meant to survive: clearing
   * every account because ONE was repointed would throw away knowledge that is still true and make
   * the other accounts re-probe. Called with no argument it clears everything, which is what a
   * shutdown or a whole-store reload wants.
   */
  forgetProfileStatus(provider?: ProviderId, profileId?: string): void {
    if (provider === undefined || profileId === undefined) {
      this.completedProfiles.clear();
      return;
    }
    this.completedProfiles.delete(profileCacheKey(provider, profileId));
  }

  /**
   * A probe that hung keeps the provider's last connected answer, if it is recent (b28d2993): every
   * CLI is probed at once, and on a busy host a hang — even after #1517's longer re-ask — said
   * nothing about the login, yet `unknown` made the action gate refuse every Start. Only a TIMEOUT
   * is bridged; any answer the CLI actually gave, and every other inconclusive reason, stands.
   */
  private bridgeTimeout(key: string, status: ProviderStatus, configDir: string | null = null): ProviderStatus {
    if (status.status === 'connected') {
      this.lastConnected.set(key, { status, at: this.now(), configDir });
      return status;
    }
    if (status.status !== 'unknown' || status.hint !== TIMEOUT_HINT) {
      this.lastConnected.delete(key);
      return status;
    }
    const last = this.lastConnected.get(key);
    // A repointed account is a different login: its old answer is no bridge.
    return last && last.configDir === configDir && this.now() - last.at <= TIMEOUT_BRIDGE_MS
      ? last.status
      : status;
  }

  /** A REMOVED account takes its runtime incident with it, so a re-added one with the same id
   *  never inherits it. Not part of `forgetProfileStatus`: a refresh must keep the incident. */
  forgetProfile(provider: ProviderId, profileId: string): void {
    this.forgetProfileStatus(provider, profileId);
    this.profileRuntimeFailures.delete(profileCacheKey(provider, profileId));
    this.lastConnected.delete(profileCacheKey(provider, profileId));
  }

  /**
   * The cached answer for one account, or `undefined` when nothing is known yet — WITHOUT
   * spawning anything.
   *
   * Every probe shells out to an agent CLI, which costs hundreds of milliseconds per provider and
   * per account. A route whose real job is "what exists" must not pay that: `GET /api/v1/health`
   * already established this posture (it serves whatever the cache holds and never pays a `gh`
   * shell-out), and this is the same rule for auth.
   *
   * The peeks deliberately ignore the TTLs below — they answer with the last thing known, however
   * old. The short window exists to stop a stale NEGATIVE from blocking a run, and a peek blocks
   * nothing: it fills in a dot on a settings page that offers Connect and a re-check right beside
   * it. Applying the window here instead made the whole cache expire in five seconds on any machine
   * where a single provider is logged out — which is most of them, since few people are signed into
   * all three — and put the shell-out straight back on the page load this exists to protect.
   * Callers that need a guaranteed-fresh answer call {@link status} or pass `refresh`.
   */
  peekProfileStatus(provider: ProviderId, profileId: string): ProviderStatus | undefined {
    if (process.env.CEZ_DRY_RUN === '1') {
      return { provider, status: 'connected', profileId };
    }
    const cached = this.completedProfiles.get(profileCacheKey(provider, profileId))?.status;
    if (cached) return this.withProfileFailure(cached, profileId);
    return this.profileRuntimeFailures.has(profileCacheKey(provider, profileId))
      ? this.withProfileFailure({ provider, status: 'disconnected' }, profileId)
      : undefined;
  }

  /** The cached default-profile rows, or `undefined` when the probe has never completed. Same
   *  no-spawn contract as {@link peekProfileStatus}. */
  peekStatus(): ProviderStatusResponse | undefined {
    if (process.env.CEZ_DRY_RUN === '1') {
      return { providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })) };
    }
    if (!this.completed) return undefined;
    return this.withRuntimeFailures(this.completed.response);
  }

  private async probe(descriptor: ProviderDescriptor, configDir?: string | null): Promise<ProviderStatus> {
    // Junie exposes no read-only auth status command. Its prompt-free model probe establishes
    // both authentication and model access; invoking `junie --version` cannot establish either.
    if (descriptor.id === 'junie') {
      try {
        const result = await this.probeJunie();
        if (result.notInstalled) return { provider: 'junie', status: 'not-installed', hint: descriptor.installHint };
        return result.connected
          ? { provider: 'junie', status: 'connected' }
          : { provider: 'junie', status: 'unknown', hint: result.hint };
      } catch (error) {
        // Same distinction as the try path above: a missing binary is "not-installed" (so the
        // GUI never offers a runner that cannot run), everything else stays "unknown" (#M1).
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          return { provider: 'junie', status: 'not-installed', hint: descriptor.installHint };
        }
        return {
          provider: 'junie',
          status: 'unknown',
          hint: `Junie authentication check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const precheck = descriptor.precheck?.();
    if (precheck !== undefined) return { provider: descriptor.id, status: precheck };
    let result: ProviderCommandResult;
    // The default profile is probed with the SAME three-argument call it always was — no
    // trailing `undefined`. `runCommand` is an injected seam, and handing every existing
    // implementation an extra argument it never asked for would be a change in the zero-config
    // path for no gain.
    const env = configDir ? profileEnv(descriptor.id, configDir) : undefined;
    const executable = descriptor.executable();
    const inconclusive = (
      reason: InconclusiveProbeReason,
      hint: string,
      outcome?: ProviderCommandResult,
    ): ProviderStatus => {
      this.reportInconclusive(descriptor, executable, env, configDir ? 'named' : 'default', reason, outcome);
      return { provider: descriptor.id, status: 'unknown', hint };
    };
    // Never pass a trailing `undefined`: the existing three- and four-argument calls are the
    // zero-config path and the injected test kit asserts them literally, so only a descriptor
    // that actually has a stdin payload reaches the five-argument form.
    const run = (
      args: readonly string[] = descriptor.statusArgs,
      timeoutMs = COMMAND_TIMEOUT_MS,
    ): Promise<ProviderCommandResult> => {
      const stdin = descriptor.stdin?.();
      return stdin !== undefined
        ? this.runCommand(executable, args, timeoutMs, env, stdin)
        : env === undefined
          ? this.runCommand(executable, args, timeoutMs)
          : this.runCommand(executable, args, timeoutMs, env);
    };
    try {
      result = await run();
      // A hang is reported only when it survives a second, longer ask outside the concurrent burst.
      if (result.timedOut) result = await run(descriptor.statusArgs, RETRY_TIMEOUT_MS);
      // A CLI that exits 0 having printed nothing at all did not answer — `claude auth status
      // --json` does this intermittently (telemetry 35838a52). Ask once more before giving up.
      if (isSilentSuccess(result) && descriptor.parse(result) === null) result = await run();
      // A signal meant for someone else (or the OOM killer) is not an answer: ask once more.
      if (wasInterrupted(result) && descriptor.parse(result) === null) result = await run();
      const fallback = descriptor.parse(result) === null ? descriptor.fallbackArgs?.(result) : undefined;
      if (fallback) result = await run(fallback);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const thrown: ProviderCommandResult = {
        stdout: '',
        stderr: '',
        exitCode: null,
        ...(typeof code === 'string' ? { errorCode: code } : {}),
      };
      // A shim `spawnableCommand` could not unwrap: say which setting to change, not "try again".
      const hint = /\.(?:cmd|bat|ps1)$/i.test(executable)
        ? `\`${executable}\` is a Windows script shim cezar cannot start without a shell. Point ${descriptor.overrideEnv} at the CLI's .exe or its .js entry point.`
        : UNKNOWN_HINT;
      return inconclusive('spawn_threw', hint, thrown);
    }
    if (result.errorCode === 'ENOENT') {
      return { provider: descriptor.id, status: 'not-installed', hint: descriptor.installHint };
    }
    if (result.timedOut) return inconclusive('timeout', TIMEOUT_HINT, result);
    if (result.errorCode) return inconclusive('spawn_error', UNKNOWN_HINT, result);
    const shimMiss = versionManagerShimMiss(result);
    if (shimMiss) {
      return {
        provider: descriptor.id,
        status: 'not-installed',
        hint: `\`${executable}\` is a version-manager shim with no version active ("${shimMiss}"). `
          + `${descriptor.installHint} Or point ${descriptor.overrideEnv} at the CLI.`,
      };
    }
    const status = descriptor.parse(result);
    if (status !== null) return { provider: descriptor.id, status };
    // Still interrupted: unknown, but unreported — there is no CLI defect to group on.
    if (wasInterrupted(result)) return { provider: descriptor.id, status: 'unknown', hint: INTERRUPTED_HINT };
    const hint = descriptor.unrecognizedHint?.(result) ?? UNKNOWN_HINT;
    // Exit 0 and 1 are the codes vendors answer status with; anything else is the CLI failing.
    if (result.exitCode === 0 || result.exitCode === 1) return inconclusive('unrecognized_output', hint, result);
    return inconclusive('unexpected_exit', hint, result);
  }

  private reportInconclusive(
    descriptor: ProviderDescriptor,
    executable: string,
    env: Record<string, string> | undefined,
    profile: 'default' | 'named',
    reason: InconclusiveProbeReason,
    result?: ProviderCommandResult,
  ): void {
    if (!this.onInconclusive) return;
    const key = `${descriptor.id}\u0000${reason}\u0000${profile}`;
    if (this.reportedInconclusive.has(key)) return;
    this.reportedInconclusive.add(key);
    const errorCode = result?.errorCode;
    try {
      this.onInconclusive({
        provider: descriptor.id,
        reason,
        profile,
        binSource: process.env[descriptor.overrideEnv] ? 'override' : isAbsolute(executable) ? 'absolute' : 'path',
        binExt: binExtension(executable),
        // Node's own codes (`EINVAL`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) — anything else is dropped.
        errorCode: errorCode && /^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode) ? errorCode : null,
        exitCode: result?.exitCode ?? null,
        stdoutBytes: result?.stdout.length ?? 0,
        stdoutJson: result ? parsesAsJson(result.stdout) : false,
        stderrBytes: result?.stderr.length ?? 0,
        cliVersion: async () => {
          const answer = await (env === undefined
            ? this.runCommand(executable, ['--version'], VERSION_TIMEOUT_MS)
            : this.runCommand(executable, ['--version'], VERSION_TIMEOUT_MS, env));
          return cliVersionFrom(answer.stdout) ?? cliVersionFrom(answer.stderr);
        },
      });
    } catch {
      // a report must never cost the probe its answer
    }
  }
}
