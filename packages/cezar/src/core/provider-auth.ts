import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
) => Promise<ProviderCommandResult>;

interface ProviderDescriptor {
  id: ProviderId;
  executable: () => string;
  statusArgs: readonly string[];
  loginArgs: readonly string[];
  installHint: string;
  parse: (result: ProviderCommandResult) => ProviderConnectionState | null;
}

const COMMAND_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5_000;
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
): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
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

  status(options?: { refresh?: boolean }): Promise<ProviderStatusResponse> {
    if (process.env.CEZ_DRY_RUN === '1') {
      return Promise.resolve({
        providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })),
      });
    }

    if (this.inFlight) {
      return this.inFlight.visible;
    }
    if (!options?.refresh && this.completed && this.now() - this.completed.timestamp < CACHE_TTL_MS) {
      return Promise.resolve(this.completed.response)
        .then((response) => this.withRuntimeFailures(response));
    }
    return this.startFreshProbe().visible;
  }

  reportRuntimeAuthFailure(provider: ProviderId): RuntimeAuthFailureReport | null {
    if (process.env.CEZ_DRY_RUN === '1') return null;
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

  loginCommand(provider: ProviderId): string {
    const descriptor = descriptorFor(provider);
    return [quoteExecutable(descriptor.executable(), this.platform), ...descriptor.loginArgs].join(' ');
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

  private async probe(descriptor: ProviderDescriptor): Promise<ProviderStatus> {
    let result: ProviderCommandResult;
    try {
      result = await this.runCommand(descriptor.executable(), descriptor.statusArgs, COMMAND_TIMEOUT_MS);
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
