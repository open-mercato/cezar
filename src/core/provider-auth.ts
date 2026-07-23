import { execFile } from 'node:child_process';

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
  hint?: string;
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
  'Authentication was rejected during a run. Reconnect, then check again.';
const ANSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const RUNTIME_AUTH_FAILURE_PATTERNS = [
  /\b(?:failed to authenticate|authentication failed|unauthenticated|unauthorized)\b/i,
  /\bproviderautherror\b/i,
  /\b(?:oauth|access|refresh)?\s*token\b.{0,80}\b(?:revoked|expired|invalid)\b/i,
  /\b(?:revoked|expired|invalid)\b.{0,80}\b(?:oauth|access|refresh)?\s*token\b/i,
  /\b(?:api[-\s]?key|x-api-key)\b\s*(?:(?:is|was|has been)\s+|[:=-]\s*)?(?:revoked|expired|invalid)\b/i,
  /\b(?:revoked|expired|invalid)\s+(?:api[-\s]?key|x-api-key)\b/i,
  /\b(?:oauth|token|credential|api[-\s]?key|x-api-key|unauthorized|unauthenticated)\b.{0,80}\b401\b/i,
  /\b401\b.{0,80}\b(?:oauth|token|credential|api[-\s]?key|x-api-key|unauthorized|unauthenticated)\b/i,
] as const;

export function isRuntimeProviderAuthFailure(message: string): boolean {
  return RUNTIME_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
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
    executable: () => 'claude',
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

export class ProviderAuthService {
  private readonly runCommand: RunProviderCommand;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly runtimeFailures = new Map<ProviderId, number>();
  private nextRuntimeFailureGeneration = 0;
  private nextProbeGeneration = 0;
  private completed?: {
    response: ProviderStatusResponse;
    timestamp: number;
    generation: number;
  };
  private inFlight?: Promise<ProviderStatusResponse>;

  constructor(options?: {
    runCommand?: RunProviderCommand;
    now?: () => number;
    platform?: NodeJS.Platform;
  }) {
    this.runCommand = options?.runCommand ?? defaultRunProviderCommand;
    this.now = options?.now ?? Date.now;
    this.platform = options?.platform ?? process.platform;
  }

  status(options?: {
    refresh?: boolean;
    recoverRuntimeFailures?: boolean;
  }): Promise<ProviderStatusResponse> {
    if (process.env.CEZ_DRY_RUN === '1') {
      return Promise.resolve({
        providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })),
      });
    }

    if (options?.recoverRuntimeFailures && options.refresh) {
      const observedFailures = new Map(this.runtimeFailures);
      return this.startFreshProbe()
        .then((response) => this.recoverRuntimeFailures(response, observedFailures));
    }

    let base: Promise<ProviderStatusResponse>;
    if (this.inFlight) {
      base = this.inFlight;
    } else if (!options?.refresh && this.completed && this.now() - this.completed.timestamp < CACHE_TTL_MS) {
      base = Promise.resolve(this.completed.response);
    } else {
      base = this.startFreshProbe();
    }

    // The runtime signal is more authoritative than a local status command.
    // Read the latch only after the async probe resolves so a rejection that
    // arrives while the command is running cannot be overwritten by its older
    // result.
    return base.then((response) => this.withRuntimeFailures(response));
  }

  reportRuntimeAuthFailure(provider: ProviderId): ProviderStatus | null {
    if (process.env.CEZ_DRY_RUN === '1') return null;
    const alreadyLatched = this.runtimeFailures.has(provider);
    this.runtimeFailures.set(provider, ++this.nextRuntimeFailureGeneration);
    if (alreadyLatched) return null;
    return { provider, status: 'disconnected', hint: RUNTIME_AUTH_HINT };
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
      providers: response.providers.map((row) => (
        this.runtimeFailures.has(row.provider)
          ? { provider: row.provider, status: 'disconnected', hint: RUNTIME_AUTH_HINT }
          : row
      )),
    };
  }

  private recoverRuntimeFailures(
    response: ProviderStatusResponse,
    observedFailures: ReadonlyMap<ProviderId, number>,
  ): ProviderStatusResponse {
    for (const row of response.providers) {
      const observedGeneration = observedFailures.get(row.provider);
      if (
        row.status === 'connected'
        && observedGeneration !== undefined
        && this.runtimeFailures.get(row.provider) === observedGeneration
      ) {
        this.runtimeFailures.delete(row.provider);
      }
    }
    return this.withRuntimeFailures(response);
  }

  private startFreshProbe(): Promise<ProviderStatusResponse> {
    const generation = ++this.nextProbeGeneration;
    const inFlight = Promise.all(DESCRIPTORS.map((descriptor) => this.probe(descriptor)))
      .then((providers) => {
        const response = { providers };
        if (!this.completed || generation >= this.completed.generation) {
          this.completed = { response, timestamp: this.now(), generation };
        }
        return response;
      });
    this.inFlight = inFlight;
    void inFlight.finally(() => {
      if (this.inFlight === inFlight) this.inFlight = undefined;
    });
    return inFlight;
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
