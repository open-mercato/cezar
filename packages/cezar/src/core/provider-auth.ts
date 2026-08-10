import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AGENT_MODELS_LOCKED_ENV } from './agent-model-policy.ts';
import { profileEnv } from './agent-profiles.ts';
import { withEnvPrefix } from './shell-env.ts';

export const PROVIDER_IDS = ['claude', 'codex', 'opencode'] as const;
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
}

export type RunProviderCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  /** Extra environment for the probe — how an agent profile's config dir reaches the CLI (spec
   *  2026-07-29-agent-profiles). Optional so every existing caller and the test kit keep their
   *  three-argument signature; absent means the default profile, which needs nothing. */
  env?: Record<string, string>,
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
  installHint: string;
  parse: (result: ProviderCommandResult) => ProviderConnectionState | null;
}

const COMMAND_TIMEOUT_MS = 10_000;
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

/** The lifetime for a set of rows: minutes only when EVERY row is connected. A mixed answer takes
 *  the short window, because the not-connected row in it is the one that might self-heal.
 *
 *  KNOWN COARSENESS: the window applies to the whole three-provider response, so one logged-out
 *  provider drags the two connected ones into re-probing with it. That is wasted work rather than a
 *  wrong answer, and it is now paid in the background; fixing it properly means per-provider
 *  timestamps and merging partial probe results. */
function cacheTtlFor(rows: readonly ProviderStatus[]): number {
  return rows.every((row) => row.status === 'connected') ? CONNECTED_TTL_MS : UNSETTLED_TTL_MS;
}
const UNKNOWN_HINT = 'Authentication could not be verified. Try again.';
const TIMEOUT_HINT = 'Authentication check timed out. Try again.';
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

const DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: 'claude',
    executable: () => process.env.CEZ_CLAUDE_BIN ?? 'claude',
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login'],
    installHint: 'Install Claude Code, then run `claude auth login`.',
    parse: parseClaudeStatus,
  },
  {
    id: 'codex',
    executable: () => process.env.CEZ_CODEX_BIN ?? 'codex',
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    installHint: 'Install the Codex CLI, then run `codex login`.',
    parse: parseCodexStatus,
  },
  {
    id: 'opencode',
    executable: () => process.env.CEZ_OPENCODE_BIN ?? 'opencode',
    statusArgs: ['auth', 'list'],
    loginArgs: ['auth', 'login'],
    installHint: 'Install OpenCode, then run `opencode auth login`.',
    parse: parseOpenCodeStatus,
  },
];

function defaultRunProviderCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
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
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: typeof code === 'number' ? code : error ? null : 0,
          errorCode: typeof code === 'string' ? code : undefined,
          timedOut: commandError?.code === 'ETIMEDOUT'
            || (commandError?.killed === true && commandError.signal === 'SIGTERM'),
        });
      },
    );
  });
}

function quoteExecutable(executable: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `"${executable.replace(/[%&!"]/g, '^$&')}"`;
  }
  return `'${executable.replaceAll("'", "'\\''")}'`;
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

export class ProviderAuthService {
  private readonly runCommand: RunProviderCommand;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly createAuthFailureId: () => string;
  private readonly runtimeFailures = new Map<ProviderId, RuntimeAuthFailure>();
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

  constructor(options?: {
    runCommand?: RunProviderCommand;
    now?: () => number;
    platform?: NodeJS.Platform;
    createAuthFailureId?: () => string;
  }) {
    this.runCommand = options?.runCommand ?? defaultRunProviderCommand;
    this.now = options?.now ?? Date.now;
    this.platform = options?.platform ?? process.platform;
    this.createAuthFailureId = options?.createAuthFailureId ?? randomUUID;
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

  /** Clear only the incident the caller actually observed. A stale retry must
   * never erase a rejection that arrived after the user began recovery. */
  clearRuntimeAuthFailure(provider: ProviderId, authFailureId: string): boolean {
    const current = this.runtimeFailures.get(provider);
    if (!current || current.authFailureId !== authFailureId) return false;
    this.runtimeFailures.delete(provider);
    return true;
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
      .then((providers) => {
        const response = { providers };
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
   * each other's answer. The runtime-auth latch is deliberately NOT applied: it is a coarse
   * per-provider signal and stamping it onto every account of that provider would mark an
   * untouched account as broken.
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
    if (cached && this.now() - cached.timestamp < cacheTtlFor([cached.status])) return cached.status;
    const pending = this.inFlightProfiles.get(key);
    if (pending) return pending;
    const probe = this.probe(descriptorFor(provider), profile.configDir)
      .then((status) => {
        const stamped: ProviderStatus = { ...status, profileId: profile.id };
        this.completedProfiles.set(key, { status: stamped, timestamp: this.now() });
        return stamped;
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
    return this.completedProfiles.get(profileCacheKey(provider, profileId))?.status;
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
    let result: ProviderCommandResult;
    // The default profile is probed with the SAME three-argument call it always was — no
    // trailing `undefined`. `runCommand` is an injected seam, and handing every existing
    // implementation an extra argument it never asked for would be a change in the zero-config
    // path for no gain.
    const env = configDir ? profileEnv(descriptor.id, configDir) : undefined;
    try {
      result = await (env === undefined
        ? this.runCommand(descriptor.executable(), descriptor.statusArgs, COMMAND_TIMEOUT_MS)
        : this.runCommand(descriptor.executable(), descriptor.statusArgs, COMMAND_TIMEOUT_MS, env));
    } catch {
      return { provider: descriptor.id, status: 'unknown', hint: UNKNOWN_HINT };
    }
    if (result.errorCode === 'ENOENT') {
      return { provider: descriptor.id, status: 'not-installed', hint: descriptor.installHint };
    }
    if (result.timedOut) {
      return { provider: descriptor.id, status: 'unknown', hint: TIMEOUT_HINT };
    }
    if (result.errorCode) {
      return { provider: descriptor.id, status: 'unknown', hint: UNKNOWN_HINT };
    }
    const status = descriptor.parse(result);
    if (status !== null) return { provider: descriptor.id, status };
    return { provider: descriptor.id, status: 'unknown', hint: UNKNOWN_HINT };
  }
}
