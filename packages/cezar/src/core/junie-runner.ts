import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { AUTO_END_DELAY_MS, DEFAULT_RUN_TIMEOUT_MS, KILL_GRACE_MS } from './claude-cli-runner.ts';
import { readNdjson } from './ndjson.ts';
import type { UiEvent } from './ui-events.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import {
  endJunieAcp,
  junieSpawnError,
  resolveJunieExecutable,
  spawnJunieAcp,
  waitForJunieAcpExit,
  JunieAcpRpc,
  type JunieAcpMessage,
} from './junie-acp-transport.ts';
import {
  createJunieUiState,
  junieSessionStarted,
  junieStopReason,
  junieTurnCompleted,
  junieTurnStarted,
  junieUsageFromResponse,
  mapJunieSessionUpdate,
  type JunieUiMapperState,
} from './junie-ui-mapper.ts';

export interface JunieRunnerOptions {
  /** Override the binary name/path; defaults to `junie` on PATH (`CEZ_JUNIE_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * `AgentRunner` over `junie --acp=true` — the real Agent Client Protocol (ACP)
 * transport junie documents as "for IDE integrations" (`junie --help`, `Acp:`
 * section), verified live against `@jetbrains/junie` 26.9.22 with an
 * authenticated session (see `junie-ui-mapper.ts`'s module doc for exactly
 * what was captured on the wire vs. mapped from the public ACP schema).
 * JSON-RPC 2.0, newline-delimited, over stdin/stdout — the same shape as
 * `codex app-server`, so this runner mirrors `CodexAppServerRunner`'s
 * process/session split.
 *
 * Auth = junie's own login (`junie` once, browser or `--auth=<token>`) or a
 * configured BYOK provider key, both stored under `~/.junie/`. ACP requires an
 * explicit `authenticate` call even when a valid credential is already cached
 * on disk (confirmed live: `session/prompt` refuses with "Authentication is
 * required" until `authenticate` has run in THIS process) — the runner sends
 * it once during bootstrap, best-effort: a real auth failure still surfaces
 * clearly from the first `session/prompt` error.
 *
 * Zero-config full-auto: `session/set_config_option(brave_mode, 'on')` right
 * after `session/new`, matching codex's `danger-full-access`/`never` and
 * opencode's auto-approve-everything default (#430's documented posture —
 * `auto` means full shell access, not a sandbox). junie has no per-tool
 * allowlist on this transport, so `spec.allowedTools`/`bashAllowlist` are
 * ignored, same as codex. A `session/request_permission` request (junie's ACP
 * approval channel) is answered with the first "allow" option regardless —
 * never observed firing live with brave_mode on, but implemented per protocol
 * for robustness rather than left to hang the turn.
 */
export class JunieRunner implements AgentRunner {
  readonly backend = 'junie' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: JunieSession | null = null;

  constructor(opts: JunieRunnerOptions = {}) {
    this.bin = resolveJunieExecutable(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const session = new JunieSession(this.bin, this.timeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

/** One live `junie --acp=true` process driving a single session. */
class JunieSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  private readonly rpc!: JunieAcpRpc;
  private stdinOpen = true;
  private sessionId: string | undefined;
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  private lastMessageId: string | undefined;
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private tokensUsed = 0;
  private busy = false;
  private readonly queue: Array<Array<Record<string, unknown>>> = [];
  /** The turn currently in flight, if any — awaited (never rejected) by the
   *  result IIFE before it settles, so a turn whose request was rejected by
   *  our own `rejectPending()` (the child already exited) still gets to emit
   *  its `note`/`turn-end` BEFORE the terminal `done` (#703 ordering: `done`
   *  must stay the true last event, not something a still-pending catch
   *  handler emits after it). */
  private activeTurn: Promise<void> = Promise.resolve();
  private ready!: Promise<void>;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private eofTermTimer: NodeJS.Timeout | undefined;
  private eofKillTimer: NodeJS.Timeout | undefined;
  private hardKillTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** Set the moment WE signal the child (EOF watchdog, cancel, kill switch) —
   *  junie handles the signal and exits `128 + signal`, so without this the
   *  runner would read its own teardown as a junie failure (#703 precedent). */
  private terminatedByCezar = false;
  private readonly hasExited: () => boolean;
  private uiState: JunieUiMapperState = createJunieUiState();

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    try {
      this.child = spawnJunieAcp(bin, spec.cwd, spec.env);
      this.rpc = new JunieAcpRpc(this.child);
    } catch (err) {
      throw junieSpawnError(err, bin);
    }

    this.hasExited = trackChildExit(this.child);
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed = junieSpawnError(err, bin);
    });
    const stderrChunks: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    const limitMs = spec.timeoutMs ?? timeoutMs;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
        this.child.stdout.destroy();
        killTimer = setTimeout(() => {
          if (!this.hasExited()) {
            this.terminatedByCezar = true;
            this.child.kill('SIGKILL');
          }
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    }

    this.ready = this.bootstrap();

    this.result = (async (): Promise<AgentRunResult> => {
      let sessionError: unknown;
      try {
        const readLoop = async () => {
          for await (const line of readNdjson(this.child.stdout)) {
            if (this.timedOut) break;
            let msg: JunieAcpMessage;
            try {
              msg = JSON.parse(line) as JunieAcpMessage;
            } catch {
              continue; // e.g. "[Junie] Applying staged update..." plain-text lines
            }
            this.dispatch(msg);
          }
        };
        await Promise.all([this.ready, readLoop()]);
      } catch (err) {
        if (!this.timedOut) {
          sessionError = err;
          this.end();
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.stdinOpen = false;
      }

      const exitCode = await waitForJunieAcpExit(this.child);
      if (this.eofTermTimer) clearTimeout(this.eofTermTimer);
      if (this.eofKillTimer) clearTimeout(this.eofKillTimer);
      if (this.hardKillTimer) clearTimeout(this.hardKillTimer);
      this.rpc.rejectPending();
      // Let a turn `rejectPending` just settled (a still-pending `session/prompt`
      // when the child exited) emit its own `note`/`turn-end` BEFORE the
      // terminal `done` below — never throws, see `activeTurn`'s doc comment.
      await this.activeTurn;

      if (this.spawnFailed) throw this.spawnFailed;
      if (sessionError) throw sessionError;

      this.textCoalescer.flush();
      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.sessionId ?? spec.sessionId,
      };

      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `junie timed out after ${mins}m and was killed` });
        this.emit({ type: 'done' });
        return base;
      }

      if (this.terminatedByCezar && isSignalTerminationExit(exitCode)) {
        this.emit({
          type: 'note',
          message: `junie did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
        this.emit({ type: 'done' });
        return base;
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const message = `junie exited with code ${exitCode}${detail}`;
        this.emit({ type: 'error', message });
        throw new Error(message);
      }

      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.stdinOpen;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.stdinOpen) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const blocks = toJuniePrompt(content);
    if (blocks.length === 0) return true;
    this.queue.push(blocks);
    void this.ready.then(() => this.drainQueue()).catch(() => undefined);
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    try {
      endJunieAcp(
        this.child,
        (term, kill) => {
          this.eofTermTimer = term;
          this.eofKillTimer = kill;
        },
        () => {
          this.terminatedByCezar = true;
        },
      );
    } catch {
      // already gone
    }
  }

  /** Hard stop (the `AgentSession` contract: `end()` is graceful, `interrupt()`
   *  is not) — `session/cancel` (a NOTIFICATION, confirmed live) best-effort,
   *  then SIGTERM immediately rather than waiting for the turn to wind down. */
  interrupt(): void {
    this.stdinOpen = false;
    if (this.sessionId) {
      try {
        this.rpc.notify('session/cancel', { sessionId: this.sessionId });
      } catch {
        // best-effort
      }
    }
    if (!this.hasExited()) {
      this.terminatedByCezar = true;
      this.child.kill('SIGTERM');
    }
  }

  hardStop(): void {
    this.interrupt();
    if (this.hardKillTimer || this.hasExited()) return;
    this.hardKillTimer = setTimeout(() => {
      if (!this.hasExited()) {
        this.terminatedByCezar = true;
        this.child.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
    this.hardKillTimer.unref?.();
  }

  // ---- protocol -----------------------------------------------------------

  private async bootstrap(): Promise<void> {
    const initResult = await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    // ACP requires an explicit `authenticate` even with a credential already
    // cached on disk (confirmed live). Best-effort: a real auth problem still
    // surfaces clearly from the first `session/prompt` error below.
    const methodId = firstAuthMethodId(initResult);
    if (methodId) {
      await this.rpc.request('authenticate', { methodId }).catch(() => undefined);
    }

    const session =
      this.spec.resume && this.spec.sessionId
        ? await this.rpc.request('session/load', { sessionId: this.spec.sessionId, cwd: this.spec.cwd, mcpServers: [] })
        : await this.rpc.request('session/new', { cwd: this.spec.cwd, mcpServers: [] });
    this.sessionId = stringField(session, 'sessionId') ?? this.spec.sessionId;
    if (this.sessionId) {
      this.emit({ type: 'session', sessionId: this.sessionId });
      const sessionId = this.sessionId;
      this.emitUi((state) => junieSessionStarted(sessionId, state));

      // Zero-config full-auto (#430's documented posture): best-effort — a
      // future protocol revision that drops this configId must not abort the
      // whole session over an internal nicety.
      await this.rpc
        .request('session/set_config_option', { sessionId, configId: 'brave_mode', value: 'on' })
        .catch(() => undefined);

      // Junie's model ids are opaque, junie-catalog strings (e.g.
      // `v1:12:jetbrains-ai:claude-sonnet-5`), never `provider/model` — a bad
      // id fails loud here rather than being swallowed (AGENT_PROTOCOL.md §9).
      if (this.spec.model) {
        await this.rpc.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: this.spec.model,
        });
      }
    } else {
      // `session/new`/`session/load` resolved without a `sessionId` — `drainQueue()` below
      // refuses to send anything while `this.sessionId` is unset, and nothing ever re-drains,
      // so a silent hang (the run sits until the wall-clock timeout) is the alternative to
      // failing loud here.
      throw new Error('junie: session/new did not return a sessionId');
    }

    const first = prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt);
    this.queue.push(toJuniePrompt([...(this.spec.images ?? []), { type: 'text', text: first }]));
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.busy || this.queue.length === 0 || !this.sessionId) return;
    const prompt = this.queue.shift();
    if (!prompt) return;
    this.busy = true;
    const turn = this.runTurn(prompt).finally(() => {
      this.busy = false;
      this.drainQueue();
    });
    this.activeTurn = turn;
  }

  private async runTurn(prompt: Array<Record<string, unknown>>): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.emitUi((state) => junieTurnStarted(state));
    try {
      const result = await this.rpc.request('session/prompt', { sessionId, prompt });
      const stopReason = junieStopReason(result.stopReason);
      const usage = junieUsageFromResponse(result.usage);
      this.textCoalescer.flush();
      if (usage) {
        this.tokensUsed += usage.total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
      }
      this.emitUi((state) => junieTurnCompleted(stopReason, usage, state));
      this.emit({ type: 'turn-end' });
    } catch (err) {
      this.textCoalescer.flush();
      const detail = err instanceof Error ? err.message : String(err);
      // Our own teardown (stdin closed, signalled, or timed out) rejects every
      // in-flight request via `rejectPending` as part of ordinary shutdown —
      // that is not a junie failure (#703 precedent), so it stays a note.
      if (!this.stdinOpen || this.terminatedByCezar || this.timedOut) {
        this.emit({ type: 'note', message: `junie: turn failed: ${detail}` });
      } else {
        this.emit({ type: 'error', message: `junie: turn failed: ${detail}` });
      }
      this.emit({ type: 'turn-end' });
    }
    // Scheduled on BOTH the success and failure paths — a failed turn still
    // ends the single-turn workflow-step session, exactly like every other
    // runner's autoEndAfterFirstTurn wiring.
    if (this.opts.autoEndAfterFirstTurn && this.stdinOpen && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
      this.autoEndTimer.unref?.();
    }
  }

  private dispatch(msg: JunieAcpMessage): void {
    if (this.rpc.dispatchResponse(msg)) return;
    if (msg.method === 'session/request_permission' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      this.handlePermissionRequest(msg.id, msg.params ?? {});
      return;
    }
    if (msg.method === 'session/update') {
      this.handleSessionUpdate(msg.params ?? {});
    }
  }

  /** junie's ACP approval channel — never observed firing live with
   *  `brave_mode: 'on'` (see the mapper's module doc), but answered per
   *  protocol rather than left to hang the turn: grant it, matching cezar's
   *  zero-config full-auto posture on every other backend (#430). Prefer
   *  `allow_once` over `allow_always` whatever order the agent lists them in —
   *  per-run full-auto must not persist a grant that outlives the run. */
  private handlePermissionRequest(id: number | string, params: Record<string, unknown>): void {
    const options = (Array.isArray(params.options) ? params.options : []).filter(isRecord);
    const allow =
      options.find((option) => option.kind === 'allow_once') ??
      options.find((option) => option.kind === 'allow_always');
    const optionId = allow ? stringField(allow, 'optionId') : undefined;
    if (!optionId) {
      this.rpc.respond({ id, error: { code: -32602, message: 'no allow option offered' } });
      return;
    }
    this.rpc.respond({ id, result: { outcome: { outcome: 'selected', optionId } } });
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = isRecord(params.update) ? params.update : undefined;
    if (!update) return;

    // v1: independent minimal tracking off the same raw frames (v2's mapper
    // owns its own item lifecycle state — see `junie-ui-mapper.ts`'s module
    // doc for why the two tracks are not derived from one another).
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    if (kind === 'agent_message_chunk') {
      const messageId = stringField(update, 'messageId');
      const text = messageChunkText(update.content);
      if (messageId && this.lastMessageId && this.lastMessageId !== messageId) {
        this.textCoalescer.complete(this.lastMessageId);
      }
      if (text) this.textCoalescer.append(messageId, text);
      this.lastMessageId = messageId ?? this.lastMessageId;
    } else if (kind === 'tool_call') {
      if (this.lastMessageId) {
        this.textCoalescer.complete(this.lastMessageId);
        this.lastMessageId = undefined;
      }
      const id = stringField(update, 'toolCallId');
      // The real tool name junie sends (v2's mapper uses the same field, see `junie-ui-mapper.ts`'s
      // `toolItemFrom`) — the ACP `kind` category (`read`/`edit`/`execute`/`other`) is only a
      // fallback for the rare frame with no title, so v1 consumers stop seeing `other` for most calls.
      const name = stringField(update, 'title') ?? (typeof update.kind === 'string' ? update.kind : 'other');
      if (id) {
        this.toolCalls.push({ id, name, input: update.rawInput ?? { title: update.title } });
        this.emit({ type: 'tool-call', id, tool: name, input: update.rawInput ?? { title: update.title } });
      }
    } else if (kind === 'tool_call_update') {
      const id = stringField(update, 'toolCallId');
      const status = typeof update.status === 'string' ? update.status : undefined;
      if (id && (status === 'completed' || status === 'failed')) {
        this.emit({
          type: 'tool-result',
          toolCallId: id,
          result: toolUpdateResultText(update),
          isError: status === 'failed',
        });
      }
    }

    this.emitUi((state) => mapJunieSessionUpdate(update, state));
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: JunieUiMapperState) => { events: UiEvent[]; state: JunieUiMapperState }): void {
    try {
      const mapped = map(this.uiState);
      this.uiState = mapped.state;
      if (this.opts.onUiEvent) {
        for (const event of mapped.events) this.opts.onUiEvent(event);
      }
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  }
}

// ---- helpers --------------------------------------------------------------

function toJuniePrompt(content: ContentBlock[]): Array<Record<string, unknown>> {
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', data: block.source.data, mimeType: block.source.media_type },
  );
}

function messageChunkText(content: unknown): string | undefined {
  if (!isRecord(content) || content.type !== 'text') return undefined;
  return typeof content.text === 'string' ? content.text : undefined;
}

/** `content:[{type:'diff',...}|{type:'content',content:{type:'text',text}}]`
 *  → the human-readable result text for the v1 `tool-result` event, falling
 *  back to `rawOutput.output` (execute) and finally the raw item as JSON. */
function toolUpdateResultText(update: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const entry of update.content) {
      if (isRecord(entry) && entry.type === 'content') {
        const text = messageChunkText(entry.content);
        if (text) parts.push(text);
      }
    }
  }
  if (parts.length > 0) return parts.join('\n');
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  if (rawOutput && typeof rawOutput.output === 'string' && rawOutput.output !== '') return rawOutput.output;
  return safeStringify(update);
}

function firstAuthMethodId(initResult: Record<string, unknown>): string | undefined {
  const methods = initResult.authMethods;
  if (!Array.isArray(methods) || methods.length === 0) return undefined;
  const first = methods[0];
  return isRecord(first) ? stringField(first, 'id') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
