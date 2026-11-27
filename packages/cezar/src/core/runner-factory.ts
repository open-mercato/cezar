import { existsSync } from 'node:fs';
import type { AgentBackend, AgentRunner, AgentRunSpec, RunnerId } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { JunieRunner } from './junie-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { KimiRunner } from './kimi-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { GeminiAcpRunner } from './gemini-acp-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { OmpRpcRunner } from './omp-rpc-runner.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { diskFloorRefusal } from '../disk-space.ts';
import { oneShotProvider, AgentProviderUnavailable, verifyProviderLogin } from './agent-provider-env.ts';
import { redactDeep, redactSecrets } from './secret-redaction.ts';
import { StreamRedaction } from '../runs/stream-redaction.ts';
import type { UiEvent } from './ui-events.ts';
import { agentModelsLocked } from './agent-model-policy.ts';
import { instructSpec } from './global-instructions.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 */
export function createRunner(backend: AgentBackend | RunnerId | undefined): AgentRunner {
  return guardWorkingDirectory(createBareRunner(backend));
}

function createBareRunner(backend: AgentBackend | RunnerId | undefined): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'cursor':
      return new CursorAgentRunner();
    case 'pi':
      return new PiRunner();
    case 'junie':
      return new JunieRunner();
    case 'copilot':
      return new CopilotAcpRunner();
    case 'omp':
      return new OmpRpcRunner();
    case 'antigravity':
      return new AntigravityRunner();
    case 'gemini':
      return new GeminiAcpRunner();
    case 'kimi':
      return new KimiRunner();
    case 'claude':
    case 'claude-cli':
    case undefined:
      return new ClaudeCliRunner();
    default: {
      const unreachable: never = backend;
      throw new Error(`Unknown runner: ${String(unreachable)}`);
    }
  }
}

/** What a run that cannot start in its directory reports (27d2e432). */
export function missingWorkingDirectoryMessage(backend: string, cwd: string): string {
  return `${backend}: cannot start — the working directory ${cwd} does not exist (the task's worktree was removed outside cezar, or the project moved). Continue re-creates the worktree from the task branch while that branch exists.`;
}

/**
 * Refuse to spawn in a directory that is gone (27d2e432), or on a volume below the free-space
 * floor (9cdcedc3) — there the agent would die mid-write with a bare ENOSPC. Without the first,
 * Node reports the missing cwd as the binary's ENOENT ("`claude` not found on PATH — install …").
 * Wraps by prototype so each runner's own state and extra members stay reachable.
 */
/**
 * Which backends can keep a read-only task read-only (AGENT_PROTOCOL.md). A Record, so a new
 * runner does not compile until someone decides. Kimi runs Edit and Write without asking, and
 * neither omp nor Antigravity has a verified read-only control, so those refuse the task.
 */
const READ_ONLY_ENFORCED: Record<AgentBackend, boolean> = {
  claude: true,
  'claude-cli': true,
  codex: true,
  opencode: true,
  cursor: true,
  pi: true,
  junie: true,
  copilot: true,
  gemini: true,
  kimi: false,
  omp: false,
  antigravity: true,
};

export function canEnforceReadOnly(backend: AgentBackend): boolean {
  return READ_ONLY_ENFORCED[backend];
}

export function readOnlyUnsupportedMessage(backend: string): string {
  return `${backend} cannot keep a read-only task from changing the repository, so cezar will not start it there. Pick another agent for this task.`;
}

function guardWorkingDirectory(runner: AgentRunner): AgentRunner {
  const check = (spec: AgentRunSpec): void => {
    if (spec.enforceReadOnly && !READ_ONLY_ENFORCED[runner.backend]) throw new Error(readOnlyUnsupportedMessage(runner.backend));
    if (!existsSync(spec.cwd)) throw new Error(missingWorkingDirectoryMessage(runner.backend, spec.cwd));
    const lowDisk = diskFloorRefusal(runner.backend, spec.cwd);
    if (lowDisk) throw new Error(lowDisk);
  };
  const guarded = Object.create(runner) as AgentRunner;
  guarded.startSession = function (spec, onEvent, opts) {
    check(spec);
    // The one place every model call passes, so no caller can forget Settings → Global instructions.
    const input = instructSpec(spec.provider?.model ? { ...spec, model: spec.provider.model } : spec);
    const key = input.provider?.secret;
    if (!key) return runner.startSession.call(this, input, onEvent, opts);
    // CLI errors, tool results and streamed text can echo arbitrary gateway keys (even short ones).
    const secrets = [key];
    const stream = new StreamRedaction();
    const scrubError = (error: unknown): never => {
      if (error instanceof AgentProviderUnavailable) throw error;
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
    };
    try {
      const session = runner.startSession.call(this, input, onEvent && (event => onEvent(redactDeep(event, secrets))), {
        ...opts,
        onUiEvent: opts?.onUiEvent && (event => {
          const { model, catalogModel } = input.provider!;
          if (model && catalogModel && model !== catalogModel) {
            if (event.type === 'session.started' && event.model === model) event = { ...event, model: catalogModel };
            if (event.type === 'turn.completed' && event.models) event = { ...event, models: event.models.map(
              share => share.model === model ? { ...share, model: catalogModel } : share,
            ) };
          }
          const frame = { ...event };
          for (const tail of stream.drain('', frame)) opts.onUiEvent!(tail as UiEvent);
          opts.onUiEvent!(redactDeep(stream.transform('', frame, secrets), secrets));
        }),
      });
      session.result = session.result.then(result => redactDeep(result, secrets), scrubError);
      return session;
    } catch (error) { return scrubError(error); }
  };
  guarded.run = async function (spec, onEvent) {
    check(spec);
    // Namer, planner, commit subjects and check selection are one-shot calls on their own runner.
    const backend = runner.backend === 'claude-cli' ? 'claude' : runner.backend;
    const provider = 'provider' in spec ? spec.provider : await oneShotProvider(backend, spec.cwd, { model: spec.model });
    await verifyProviderLogin(backend, provider, spec.cwd, spec.env);
    const input = provider ? {
      ...spec,
      provider,
      model: agentModelsLocked(spec.cwd) ? undefined : provider.model ?? spec.model,
      onUsageWindows: provider.secret ? undefined : spec.onUsageWindows,
    } : spec;
    return runner.run.call(this, instructSpec(input), onEvent);
  };
  return guarded;
}
