import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSignalTerminationExit,
  prependSystemPrompt,
  trackChildExit,
  type AgentBackend,
  type AgentEvent,
  type AgentRunResult,
  type AgentRunSpec,
  type AgentRunner,
  type AgentSession,
  type AgentToolCallRecord,
  type ContentBlock,
  type SessionOptions,
} from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { AcpClient, type AcpContentBlock, type AcpMessage, type AcpRequestAnswer } from './acp-client.ts';
import { acpMcpCapabilities, skippedServersNote, toAcpMcpServers } from './private-mcp.ts';
import { abortAcpTurn, endAcpReplay, mapAcpFrame, type AcpUiMapperState } from './acp-ui-mapper.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS } from './claude-cli-runner.ts';
import {
  COPILOT_AUTH_FAILURE_MESSAGE,
  copilotDialect,
  createCopilotUiState,
  isCopilotAuthFailure,
} from './copilot-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** `initialize` / `session/new` / `session/load` are handshakes: bounded, unlike a prompt. */
const HANDSHAKE_TIMEOUT_MS = 90_000;
/**
 * How long to wait for the end of a `session/load` replay (`available_commands_update`) before
 * prompting anyway. Whether Copilot replays a loaded session's history at all is **unverified**
 * (no entitled credential was available — see `__fixtures__/copilot/README.md`), so this is a
 * bound, not an expectation: an agent that never sends the marker costs one 5s wait on resume.
 */
const REPLAY_WAIT_MS = 5_000;
const AUTO_END_DELAY_MS = 250;

export interface CopilotAcpRunnerOptions {
  /** Override the binary; defaults to `copilot` on PATH (`CEZ_COPILOT_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * GitHub Copilot CLI over the Agent Client Protocol (#582, spec
 * `2026-09-19-runner-seam-native-backends` Phase 3): one long-lived `copilot --acp` child and one
 * ACP session per cezar session. Follow-ups are further `session/prompt` calls on the same
 * process; Continue resumes with `session/load`.
 *
 * The wire was verified against `@github/copilot` 1.0.88 — the record is
 * `.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md` and the fixtures are
 * `__fixtures__/copilot/`. Permissions are `auto` only (spec Q15): the child starts with
 * `--allow-all-tools`, and a `session/request_permission` that still arrives is auto-approved with
 * a note, so no request can park a run nothing is able to wake.
 */
export class CopilotAcpRunner implements AgentRunner {
  readonly backend = 'copilot' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: CopilotAcpRunnerOptions = {}) {
    this.bin =
      opts.bin ?? process.env.CEZ_COPILOT_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockCopilotPath() : 'copilot');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const session = new CopilotAcpSession(this.bin, this.backend, spec, spec.timeoutMs ?? this.timeoutMs, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

/**
 * The CLI flags for one run. Every one is from `copilot --help` on 1.0.88 (see the notes):
 *
 * - `--acp` starts the ACP server on stdio. There is **no `--stdio` flag** — the spec's
 *   `copilot --acp --stdio` was wrong, and passing it makes the CLI exit on an unknown option.
 * - `--allow-all-tools` is the `auto` permission mode (Q15). The **flag**, deliberately, not
 *   `COPILOT_ALLOW_ALL=true`: set to exactly `"true"` that variable *also* trusts the working
 *   directory, which loads its skills, plugins, MCP servers and hooks — including hooks that run
 *   shell commands. A cezar worktree is a checkout of someone else's branch; that is not a trust
 *   decision this runner gets to make.
 * - `--no-auto-update` because a CLI that swaps itself out mid-task is not reproducible, and the
 *   download is not something a run should pay for.
 * - `--add-dir` carries `AgentRunSpec.additionalDirectories`; the session cwd is the spawn cwd.
 *
 * `spec.allowedTools` / `spec.bashAllowlist` are NOT translated to `--allow-tool` / `--deny-tool`.
 * Permission modes are out of scope for this phase (Q15), and a partial mapping would look like a
 * sandbox while behaving like `--allow-all-tools`, which is worse than the honest version.
 */
export function buildCopilotArgs(spec: Pick<AgentRunSpec, 'model' | 'additionalDirectories'>): string[] {
  const args = ['--acp', '--allow-all-tools', '--no-auto-update'];
  if (spec.model) args.push('--model', spec.model);
  for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  return args;
}

/** The per-run environment: `buildChildEnv`'s least-privilege set for this backend. Copilot's own
 *  `COPILOT_` family and the shared `gh` names are what `agent-env.ts` already allows it. */
export function buildCopilotEnv(backend: AgentBackend, extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return buildChildEnv({ backend, extraEnv });
}

/**
 * A cezar-authored line for an exit outside a prompt.
 *
 * Copilot's exit codes are **not documented and were not verified**, so — unlike the Gemini
 * runner, which can name 41/52/55 — this reports the code and the tail of stderr rather than
 * inventing meanings. The one case worth translating is an authentication failure, because that
 * wording is what raises `provider-auth-required`.
 */
export function copilotExitMessage(exitCode: number | null, stderr: string): string {
  if (isCopilotAuthFailure(stderr)) return COPILOT_AUTH_FAILURE_MESSAGE;
  const detail = stderr.trim().split('\n').slice(-3).join(' | ');
  return `Copilot CLI exited with code ${exitCode}${detail ? ` — ${truncate(detail, 400)}` : ''}`;
}

class CopilotAcpSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  readonly pid?: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly client: AcpClient;
  private readonly hasExited: () => boolean;
  private ui: AcpUiMapperState = createCopilotUiState();
  private acpSessionId: string | undefined;
  private loadSupported = false;
  private imagesSupported = false;

  private isOpen = true;
  private turnInFlight = false;
  private turnsCompleted = 0;
  private readonly queue: AcpContentBlock[][] = [];
  private terminatedByCezar = false;
  private timedOut = false;
  private failed: string | null = null;
  private replayDone: (() => void) | null = null;

  private readonly textChunks: string[] = [];
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private tokensUsed = 0;
  private readonly stderr: string[] = [];
  private spawnError: Error | null = null;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    bin: string,
    backend: AgentBackend,
    private readonly spec: AgentRunSpec,
    private readonly limitMs: number,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    this.child = nodeSpawn(bin, buildCopilotArgs(spec), { cwd: spec.cwd, env: buildCopilotEnv(backend, spec.env) });
    this.pid = this.child.pid;
    this.hasExited = trackChildExit(this.child);
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.spawnError =
        error.code === 'ENOENT'
          ? new Error(`\`${bin}\` not found on PATH — install GitHub Copilot CLI (npm i -g @github/copilot) and run \`copilot login\``)
          : error;
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.client = new AcpClient(this.child.stdin, this.child.stdout, {
      onFrame: (dir, frame) => this.onFrame(dir, frame),
      onRequest: (request) => this.onRequest(request),
      onUnparseable: (line) => this.emit({ type: 'note', message: `copilot: skipped unparseable ACP line: ${truncate(line, 200)}` }),
    });

    if (this.limitMs > 0) {
      const deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, this.limitMs);
      deadline.unref?.();
      this.timers.push(deadline);
    }
    this.result = this.lifecycle();
  }

  get open(): boolean {
    return this.isOpen;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.isOpen || this.client.closed) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    // ACP has no steering: a message sent mid-turn waits for the turn to end, in order.
    this.queue.push(this.toAcp(content));
    this.pump();
    return true;
  }

  end(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.terminate(false);
  }

  interrupt(): void {
    if (this.acpSessionId && this.turnInFlight) this.client.cancel(this.acpSessionId);
    this.isOpen = false;
    this.terminate(true);
  }

  // ---- lifecycle ------------------------------------------------------------------------

  private async lifecycle(): Promise<AgentRunResult> {
    const reading = this.client.run();
    const exited = waitForExit(this.child);
    try {
      await this.bootstrap();
    } catch (error) {
      // An agent that went away mid-handshake is explained by its exit, read below — not by the
      // transport's "closed" rejection.
      if (!this.spawnError && !this.client.closed) this.fail(error instanceof Error ? error.message : String(error));
      this.terminate(false);
    }

    await reading;
    const exitCode = await exited;
    for (const timer of this.timers) clearTimeout(timer);
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
    this.isOpen = false;

    if (this.spawnError) throw this.spawnError;
    if (this.turnInFlight) {
      // The agent died with a prompt unanswered: the transport rejected it, the wire never will.
      this.turnInFlight = false;
      if (this.timedOut) this.applyUi(abortAcpTurn(this.ui, copilotDialect, 'timeout'));
      else if (this.terminatedByCezar) this.applyUi(abortAcpTurn(this.ui, copilotDialect, 'cancelled'));
      else {
        const reason = copilotExitMessage(exitCode, this.stderrText());
        this.applyUi(abortAcpTurn(this.ui, copilotDialect, 'error', reason));
        this.fail(reason);
      }
    }
    const summary = (): AgentRunResult => ({
      text: this.textChunks.join('').trim(),
      toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed,
      ...(this.acpSessionId ? { sessionId: this.acpSessionId } : {}),
    });

    if (this.timedOut) {
      const minutes = Math.round((this.limitMs / 60_000) * 10) / 10;
      this.emit({ type: 'error', message: `Copilot CLI timed out after ${minutes}m and was killed` });
      this.emit({ type: 'done' });
      return summary();
    }
    if (this.failed) {
      this.opts.onUiEvent?.({ type: 'session.ended', reason: 'error' });
      this.emit({ type: 'done' });
      return summary();
    }
    if (!this.acpSessionId && !this.terminatedByCezar && (exitCode === 0 || exitCode === null)) {
      this.fail('Copilot CLI exited before it started a session');
      this.opts.onUiEvent?.({ type: 'session.ended', reason: 'error' });
      this.emit({ type: 'done' });
      return summary();
    }
    if (exitCode !== 0 && exitCode !== null) {
      if (this.terminatedByCezar && (isSignalTerminationExit(exitCode) || exitCode === 1)) {
        this.emit({ type: 'note', message: `Copilot CLI exited ${exitCode} after cezar stopped it` });
      } else if (!this.terminatedByCezar) {
        const message = copilotExitMessage(exitCode, this.stderrText());
        this.emit({ type: 'error', message });
        throw new Error(message);
      }
    }
    if (this.tokensUsed === 0 && this.turnsCompleted > 0) {
      this.emit({ type: 'note', message: 'token usage not reported by Copilot CLI' });
    }
    this.opts.onUiEvent?.({ type: 'session.ended', reason: this.terminatedByCezar && this.turnsCompleted === 0 ? 'cancelled' : 'end_turn' });
    this.emit({ type: 'done' });
    return summary();
  }

  private async bootstrap(): Promise<void> {
    const init = await this.client.initialize(HANDSHAKE_TIMEOUT_MS);
    const caps = isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
    this.loadSupported = caps.loadSession === true;
    this.imagesSupported = isRecord(caps.promptCapabilities) && caps.promptCapabilities.image === true;
    const { mcpServers, skipped } = toAcpMcpServers(this.spec.mcpServers ?? [], acpMcpCapabilities(init));
    if (skipped.length) {
      this.emit({ type: 'note', message: skippedServersNote('copilot', skipped, 'the CLI did not advertise that MCP transport') });
    }

    let resumed = false;
    if (this.spec.resume && this.spec.sessionId) {
      if (this.loadSupported) {
        const replayEnded = new Promise<void>((resolve) => {
          this.replayDone = resolve;
        });
        try {
          await this.client.loadSession(this.spec.sessionId, this.spec.cwd, HANDSHAKE_TIMEOUT_MS, mcpServers);
          this.acpSessionId = this.spec.sessionId;
          resumed = true;
          await Promise.race([replayEnded, delay(REPLAY_WAIT_MS)]);
          this.ui = endAcpReplay(this.ui);
        } catch (error) {
          this.replayDone = null;
          this.ui = endAcpReplay(this.ui);
          this.emit({
            type: 'note',
            message: `Copilot could not resume session ${this.spec.sessionId} (${error instanceof Error ? error.message : String(error)}) — starting a fresh session`,
          });
        }
      } else {
        this.emit({ type: 'note', message: 'Copilot CLI does not advertise session/load — starting a fresh session' });
      }
    }
    if (!this.acpSessionId) {
      const created = await this.client.newSession(this.spec.cwd, HANDSHAKE_TIMEOUT_MS, mcpServers).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          isCopilotAuthFailure(`${message}\n${this.stderrText()}`)
            ? COPILOT_AUTH_FAILURE_MESSAGE
            : `Copilot CLI could not start a session: ${message}`,
        );
      });
      const id = typeof created.sessionId === 'string' ? created.sessionId : undefined;
      if (!id) throw new Error('Copilot CLI answered session/new without a sessionId');
      this.acpSessionId = id;
    } else if (resumed && this.spec.model) {
      // `--model` only reaches a session this process CREATED; a loaded one keeps the model it was
      // saved with, so a run whose model changed between turns (#954) has to say so. Copilot's
      // `session/load` result shape is unverified, so this asks unconditionally rather than
      // comparing against a field that may not be there.
      await this.client.setModel(this.acpSessionId, this.spec.model, HANDSHAKE_TIMEOUT_MS).catch((error: unknown) => {
        this.emit({
          type: 'note',
          message: `Copilot kept its own model: session/set_model failed (${error instanceof Error ? error.message : String(error)})`,
        });
      });
    }
    this.emit({ type: 'session', sessionId: this.acpSessionId });

    const first: ContentBlock[] = [
      ...(this.spec.images ?? []),
      { type: 'text', text: prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt) },
    ];
    this.queue.unshift(this.toAcp(first));
    this.pump();
  }

  /** Send the next queued prompt when no turn is running. */
  private pump(): void {
    if (this.turnInFlight || !this.acpSessionId || this.queue.length === 0 || this.client.closed) return;
    const prompt = this.queue.shift()!;
    this.turnInFlight = true;
    this.client.prompt(this.acpSessionId, prompt).then(
      () => this.turnEnded(),
      // An error ANSWER ends the turn (the mapper already settled it); a lost transport does not —
      // the lifecycle settles that one once it knows why the agent went away.
      () => {
        if (!this.client.closed) this.turnEnded();
      },
    );
  }

  private turnEnded(): void {
    if (!this.turnInFlight) return;
    this.turnInFlight = false;
    this.turnsCompleted += 1;
    this.emit({ type: 'turn-end' });
    if (this.queue.length > 0) {
      this.pump();
      return;
    }
    if (this.opts.autoEndAfterFirstTurn && this.isOpen && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
      this.autoEndTimer.unref?.();
    }
  }

  // ---- wire → events --------------------------------------------------------------------

  private onFrame(dir: 'in' | 'out', frame: AcpMessage): void {
    if (
      dir === 'in'
      && this.replayDone
      && isRecord(frame.params)
      && isRecord(frame.params.update)
      && frame.params.update.sessionUpdate === 'available_commands_update'
    ) {
      const done = this.replayDone;
      this.replayDone = null;
      // Let the mapper see the marker first, then release the prompt.
      queueMicrotask(done);
    }
    this.applyUi(mapAcpFrame({ dir, frame }, this.ui, copilotDialect));
  }

  private applyUi(mapped: { events: UiEvent[]; state: AcpUiMapperState }): void {
    this.ui = mapped.state;
    for (const event of mapped.events) {
      this.opts.onUiEvent?.(event);
      this.v1FromUi(event);
    }
  }

  /** v1 derived from v2 (AGENT_PROTOCOL.md §2: every v1 event stays derivable from the v2 stream). */
  private v1FromUi(event: UiEvent): void {
    switch (event.type) {
      case 'item.delta':
        if (event.field === 'text') {
          this.textChunks.push(event.delta);
          this.emit({ type: 'text', text: event.delta });
        }
        return;
      case 'item.started':
        if (event.item.kind === 'tool') {
          const input = event.item.input ?? { title: event.item.title };
          this.toolCalls.push({ id: event.item.id, name: event.item.name, input });
          this.emit({ type: 'tool-call', id: event.item.id, tool: event.item.name, input });
        }
        return;
      case 'item.completed':
        if (event.item.kind === 'tool') {
          const failed = event.item.status === 'failed' || event.item.status === 'declined';
          this.emit({
            type: 'tool-result',
            toolCallId: event.item.id,
            result: (failed ? event.item.error : event.item.output) ?? '',
            isError: failed,
          });
        }
        return;
      case 'image':
        this.emit({ type: 'image', mediaType: event.mediaType, data: event.data });
        return;
      case 'usage.updated':
        this.tokensUsed = event.usage.total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
        return;
      case 'session.error':
        // A failed prompt or session is the step's failure. A failed resume is not (the bootstrap
        // notes it and starts a fresh session).
        if (event.fatal || this.turnInFlight) this.fail(event.message);
        return;
      default:
        return;
    }
  }

  private onRequest(request: AcpMessage): AcpRequestAnswer {
    if (request.method !== 'session/request_permission' || !isRecord(request.params)) {
      return { error: { code: -32601, message: `Method not found: ${String(request.method)}` } };
    }
    const options = Array.isArray(request.params.options) ? request.params.options.filter(isRecord) : [];
    const choice =
      options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
    const title =
      isRecord(request.params.toolCall) && typeof request.params.toolCall.title === 'string'
        ? request.params.toolCall.title
        : 'a tool call';
    if (!choice || typeof choice.optionId !== 'string') {
      this.emit({ type: 'note', message: `Copilot asked permission for ${title} with no option cezar could pick; cancelled` });
      return { result: { outcome: { outcome: 'cancelled' } } };
    }
    this.emit({
      type: 'note',
      message: `Copilot asked permission for ${title}; auto-approved (${String(choice.kind ?? choice.optionId)}) — cezar runs Copilot in auto mode`,
    });
    return { result: { outcome: { outcome: 'selected', optionId: choice.optionId } } };
  }

  // ---- helpers --------------------------------------------------------------------------

  private toAcp(content: ContentBlock[]): AcpContentBlock[] {
    const blocks: AcpContentBlock[] = [];
    let droppedImages = 0;
    for (const block of content) {
      if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
      else if (this.imagesSupported || !this.acpSessionId) {
        blocks.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
      } else droppedImages += 1;
    }
    if (droppedImages > 0) this.emit({ type: 'note', message: `Copilot CLI does not accept images; dropped ${droppedImages}` });
    return blocks;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = message;
    this.emit({ type: 'error', message });
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  private stderrText(): string {
    return this.stderr.join('');
  }

  /** Close stdin, then SIGTERM→SIGKILL for a CLI that ignores EOF (#703, #844). `hard` skips the
   *  EOF grace: cancel means now. */
  private terminate(hard: boolean): void {
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
    const signal = (sig: NodeJS.Signals): void => {
      if (this.hasExited()) return;
      this.terminatedByCezar = true;
      this.child.kill(sig);
    };
    if (hard) {
      this.terminatedByCezar = true;
      signal('SIGTERM');
      const kill = setTimeout(() => signal('SIGKILL'), EOF_KILL_GRACE_MS);
      kill.unref?.();
      this.timers.push(kill);
      return;
    }
    const term = setTimeout(() => {
      signal('SIGTERM');
      const kill = setTimeout(() => signal('SIGKILL'), EOF_KILL_GRACE_MS);
      kill.unref?.();
      this.timers.push(kill);
    }, EOF_TERM_GRACE_MS);
    term.unref?.();
    this.timers.push(term);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(child.exitCode ?? null));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Path to the bundled mock (`scripts/mock-copilot-acp.mjs`), for CEZ_DRY_RUN=1. */
function mockCopilotPath(): string {
  // Resolved like `mockPiPath`: `new URL().pathname` yields `/C:/…` on Windows, which spawn rejects.
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-copilot-acp.mjs');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
