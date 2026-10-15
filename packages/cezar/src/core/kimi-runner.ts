import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { buildChildEnv } from './agent-env.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS } from './claude-cli-runner.ts';
import { agentKimiHome, kimiHome } from './kimi-home.ts';
import { readNdjson } from './ndjson.ts';
import { acpMcpCapabilities, skippedServersNote, toAcpMcpServers } from './private-mcp.ts';
import { localLauncher, type ProcessLauncher } from './process-launcher.ts';
import type { StopReason, UiEvent, UiToolItem } from './ui-events.ts';
import { costWeightedTokens } from './usage.ts';
import {
  abortKimiTurn,
  createKimiUiState,
  kimiSessionStarted,
  kimiTurnStarted,
  mapKimiMessage,
  type KimiUiMapperState,
  type KimiUiMapping,
} from './kimi-ui-mapper.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** `initialize` / `session/new|resume` / `session/set_config_option` are handshakes: bounded,
 *  unlike a prompt (the run's own deadline owns a turn). */
const HANDSHAKE_TIMEOUT_MS = 90_000;
const AUTO_END_DELAY_MS = 250;
/**
 * Kimi appends a turn's last `usage.record` around the moment it answers the prompt, so the reader
 * polls until the log's own `turn.ended` marker shows the turn is fully written — bounded, since a
 * missing marker must cost a turn its usage, never hang the session.
 */
const USAGE_POLL_MS = 50;
const USAGE_SETTLE_MAX_MS = 2_000;

/**
 * The tools cezar's `allowedTools` vocabulary names. Kimi uses the same names. Kimi's own tools
 * (Agent, TodoList, FetchURL…) are outside that vocabulary and stay allowed, as every other
 * backend treats them. Which of these can actually be DENIED is a different, smaller set — see
 * `PERMISSION_GATED_TOOLS`.
 */
const ALLOWLISTABLE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);
/**
 * Of those, the ones Kimi asks permission for in its `default` mode — the only point where cezar
 * can say no. In the captured session (`__fixtures__/kimi/acp-session.ndjson`) Kimi prompted for
 * `Bash` and ran `Edit` without asking; no `mode` it offers (`default`/`plan`/`auto`/`yolo`) is
 * documented to make edits prompt, and none was verified to.
 */
const PERMISSION_GATED_TOOLS: ReadonlySet<string> = new Set(['Bash']);

export interface KimiRunnerOptions {
  /** Override the binary name/path; defaults to `kimi` on PATH (`CEZ_KIMI_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** Bound on each handshake request (ms). Defaults to 90s; tests shorten it. */
  handshakeTimeoutMs?: number;
  /** WHERE the CLI runs: this machine, or a podman task container (see `backendSupportsLauncher`). */
  launcher?: ProcessLauncher;
}

/**
 * `AgentRunner` over Kimi Code's Agent Client Protocol server (`kimi acp`): JSON-RPC 2.0,
 * newline-delimited, over stdin/stdout — the transport Zed and the other ACP editors use.
 * Contract: https://agentclientprotocol.com. The wire was captured from Kimi Code CLI 2.1.1
 * (`agentInfo.version`; its bundled ACP agent is 0.39.1) — `__fixtures__/kimi/acp-session.ndjson`.
 *
 * One long-lived process per session: `session/new` (or `session/resume` for "Continue", falling
 * back to a fresh session when Kimi no longer knows the id), then one `session/prompt` per turn —
 * its RESPONSE is the end of the turn. ACP has no mid-turn steering, so a follow-up typed during a
 * turn is queued and sent as the next turn. `session/cancel` interrupts. A prompt the agent never
 * answers — it died, or cezar stopped it — is settled by the runner (`abortKimiTurn`), never left
 * open and never reported as a clean turn.
 *
 * Isolation: under a podman launcher the image's `kimi` runs in the task container, logged in
 * through the credentials directory `podmanRunArgs` mounts, with its home — and so its session
 * log — on the host (the launcher's per-project Kimi agent home).
 *
 * Kimi has no system-prompt channel over ACP, so `spec.systemPrompt` rides as a leading block of
 * the opening message (`prependSystemPrompt`), as with codex and opencode. The model is chosen
 * with `session/set_config_option`; an id Kimi does not offer fails the run loudly rather than
 * running on the default. Private MCP servers ride ACP's `session/new|resume` `mcpServers`.
 *
 * Permissions: cezar's default permission mode is autonomous, so every `session/request_permission`
 * is answered — approved, except `Bash` when the step's `allowedTools` leaves it out or a
 * `bashAllowlist` narrows it (the prompt carries a truncated command, so a prefix check could not
 * be trusted — fail closed, as pi does). That is the WHOLE of the enforcement: Kimi runs `Edit`,
 * `Write`, `Read`, `Grep` and `Glob` without asking, so — like Codex and OpenCode — it cannot
 * enforce `allowedTools` for them, and a step that excludes them gets a note saying so rather
 * than a sandbox that is not there.
 *
 * Token usage is not on the ACP wire; Kimi writes it to its own session log. See
 * `KimiUsageReader` and the header of `kimi-ui-mapper.ts`.
 */
export class KimiRunner implements AgentRunner {
  readonly backend = 'kimi' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly launcher: ProcessLauncher;
  private lastSession: AgentSession | null = null;

  constructor(opts: KimiRunnerOptions = {}) {
    this.launcher = opts.launcher ?? localLauncher;
    // In a container the host's path to its binary means nothing: the image puts `kimi` on PATH.
    this.bin = opts.bin ?? (this.launcher.id === 'local' ? resolveKimiExecutable() : 'kimi');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
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
    const session = new KimiSession(
      this.bin,
      spec.timeoutMs ?? this.timeoutMs,
      this.handshakeTimeoutMs,
      spec,
      onEvent,
      opts,
      this.launcher,
    );
    this.lastSession = session;
    return session;
  }
}

/**
 * `CEZ_KIMI_BIN`, else the dry-run mock, else `kimi` — found on PATH or, failing that, where Kimi's
 * installer puts it (`~/.kimi-code/bin/kimi`). The installer adds that directory to the user's
 * shell profile only, so a cockpit started by launchd or a desktop session would otherwise
 * report Kimi missing on a machine where it works in every terminal.
 */
export function resolveKimiExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CEZ_KIMI_BIN) return env.CEZ_KIMI_BIN;
  if (env.CEZ_DRY_RUN === '1') return mockKimiPath();
  if (onPath('kimi', env.PATH)) return 'kimi';
  const installed = join(env.HOME ?? homedir(), '.kimi-code', 'bin', 'kimi');
  return existsSync(installed) ? installed : 'kimi';
}

function onPath(bin: string, path: string | undefined): boolean {
  return (path ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, bin)));
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** An ACP prompt content block (the subset cezar sends: text and base64 images). */
type AcpBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

class KimiSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hasExited: () => boolean;
  private readonly exited: Promise<number | null>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Set once the agent's output is gone: every waiting request is rejected, every later one too. */
  private closedReason: string | null = null;
  private stdinOpen = true;
  private sessionId: string | undefined;
  private readonly ready: Promise<void>;
  private promptId: number | undefined;
  /** True once the opening prompt has been sent; until then follow-ups queue behind it. */
  private opened = false;
  private imagesSupported = true;
  private readonly queued: ContentBlock[][] = [];
  private uiState: KimiUiMapperState = createKimiUiState();
  private usage: KimiUsageReader | undefined;
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly announced = new Set<string>();
  private readonly textChunks: string[] = [];
  /** Cost-weighted tokens of the live turn, and of the turns already completed. */
  private tokensUsed = 0;
  private runTokens = 0;
  /** Turns Kimi itself answered — the only ones whose usage the session log can be expected to hold. */
  private turnsAnswered = 0;
  private lastStopReason: StopReason = 'end_turn';
  private autoEndTimer: NodeJS.Timeout | undefined;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly stderr: string[] = [];
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** Set when cezar asked the session to close — an unanswered turn then ended because we said so. */
  private endRequested = false;
  /** Set when WE signal the child, so its 143 is read as our teardown, not a Kimi failure. */
  private terminatedByCezar = false;
  private killEscalated = false;

  constructor(
    private readonly bin: string,
    private readonly limitMs: number,
    private readonly handshakeTimeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
    private readonly launcher: ProcessLauncher,
  ) {
    this.env = buildChildEnv({ backend: 'kimi', extraEnv: spec.env });
    this.child = launcher.spawn(bin, ['acp'], { cwd: spec.cwd, env: this.env });
    this.hasExited = trackChildExit(this.child);
    this.exited = waitForExit(this.child);
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed ??= kimiSpawnError(err, bin);
      this.close('kimi acp failed to start');
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));

    if (limitMs > 0) {
      const deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, limitMs);
      deadline.unref?.();
      this.timers.push(deadline);
    }

    this.ready = this.bootstrap();
    this.result = this.lifecycle();
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
    if (content.length === 0) return true;
    // ACP has no steering: a message typed mid-turn — or before the opening prompt has even gone
    // out — becomes the next turn. Only one `session/prompt` is ever in flight.
    if (this.promptId !== undefined || !this.opened) {
      this.queued.push(content);
      return true;
    }
    const blocks = this.toAcp(content);
    if (blocks.length > 0) this.prompt(blocks);
    return true;
  }

  /** Graceful close: end input, then SIGTERM→SIGKILL for a CLI that ignores EOF. */
  end(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    this.endRequested = true;
    this.closeStdin();
    this.after(EOF_TERM_GRACE_MS, () => this.escalate());
  }

  /** Hard stop: cancel the turn best-effort, then SIGTERM now and SIGKILL if it is ignored. */
  interrupt(): void {
    if (this.sessionId && this.promptId !== undefined) {
      this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    }
    this.stdinOpen = false;
    this.endRequested = true;
    this.closeStdin();
    this.escalate();
  }

  /** Cancel's escalation (`run.ts`, after its own grace): the process goes now. */
  hardStop(): void {
    this.interrupt();
    this.signal('SIGKILL');
  }

  // ---- lifecycle ------------------------------------------------------------

  private async lifecycle(): Promise<AgentRunResult> {
    const reading = this.readLoop();
    let sessionError: Error | undefined;
    try {
      await this.ready;
    } catch (err) {
      // A transport that closed mid-handshake is explained by the exit, read below — not by the
      // "closed" rejection. Neither is a stop cezar asked for.
      if (this.closedReason === null && !this.endRequested) {
        sessionError = err instanceof Error ? err : new Error(String(err));
      }
      this.stdinOpen = false;
      this.closeStdin();
      this.escalate();
    }

    await reading;
    const exitCode = await this.exited;
    for (const timer of this.timers) clearTimeout(timer);
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
    this.stdinOpen = false;

    if (this.spawnFailed) throw this.spawnFailed;
    if (sessionError) return this.failSession(sessionError.message);

    const exitedBadly =
      exitCode !== 0 && exitCode !== null && !(this.terminatedByCezar && isSignalTerminationExit(exitCode));
    if (this.promptId !== undefined) {
      // Kimi went away with a prompt unanswered: no response will ever end that turn, so settle it.
      this.promptId = undefined;
      for (const record of this.usage?.read().records ?? []) this.emitUi((state) => mapKimiMessage(record, state));
      if (this.timedOut) this.emitUi((state) => abortKimiTurn(state, 'timeout'));
      else if (this.endRequested || this.terminatedByCezar) this.emitUi((state) => abortKimiTurn(state, 'cancelled'));
      else {
        const message = exitedBadly
          ? this.exitMessage(exitCode)
          : `kimi acp exited${exitCode === null ? '' : ` with code ${exitCode}`} without answering the prompt`;
        this.emitUi((state) => abortKimiTurn(state, 'error', message));
        this.opts.onUiEvent?.({ type: 'session.ended', reason: 'error' });
        throw new Error(message);
      }
    }

    const base: AgentRunResult = {
      text: this.textChunks.join('\n').trim(),
      toolCalls: this.toolCalls,
      tokensUsed: this.runTokens + this.tokensUsed,
      sessionId: this.sessionId ?? this.spec.sessionId,
    };
    if (this.timedOut) {
      const mins = Math.round((this.limitMs / 60_000) * 10) / 10;
      this.emit({ type: 'error', message: `kimi acp timed out after ${mins}m and was killed` });
      this.opts.onUiEvent?.({ type: 'session.ended', reason: 'timeout' });
      this.emit({ type: 'done' });
      return base;
    }
    if (exitedBadly) return this.failSession(this.exitMessage(exitCode));
    if (!this.sessionId && !this.endRequested) return this.failSession('kimi acp exited before it started a session');
    if (base.tokensUsed === 0 && this.turnsAnswered > 0) {
      this.emit({ type: 'note', message: 'token usage not found in the kimi session log' });
    }
    const reason: StopReason = this.turnsAnswered === 0 && this.endRequested ? 'cancelled' : this.lastStopReason;
    this.opts.onUiEvent?.({ type: 'session.ended', reason });
    this.emit({ type: 'done' });
    return base;
  }

  /** The session could not start or keep going: said ONCE, on both streams, then thrown. */
  private failSession(message: string): never {
    this.opts.onUiEvent?.({ type: 'session.error', message, fatal: true });
    this.emit({ type: 'error', message });
    this.opts.onUiEvent?.({ type: 'session.ended', reason: 'error' });
    throw new Error(message);
  }

  private exitMessage(exitCode: number | null): string {
    const detail = this.stderr.join('').trim().split('\n').slice(-3).join(' | ');
    return `kimi acp exited with code ${exitCode}${detail ? ` — ${truncate(detail, 400)}` : ''}`;
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of readNdjson(this.child.stdout)) {
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line) as RpcMessage;
        } catch {
          this.emit({ type: 'note', message: `kimi: skipped unparseable ACP line: ${truncate(line)}` });
          continue;
        }
        await this.handle(msg);
      }
    } catch {
      // a destroyed stdout ends the read like EOF does; the exit explains why
    } finally {
      this.close('kimi acp closed its output');
    }
  }

  // ---- protocol -----------------------------------------------------------

  private async bootstrap(): Promise<void> {
    const handshake = { timeoutMs: this.handshakeTimeoutMs };
    const init = await this.request(
      'initialize',
      {
        protocolVersion: 1,
        // cezar serves no files or terminals: Kimi uses its own tools in `cwd`.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      handshake,
    );
    const caps = isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
    // Kimi 2.1.1 advertises images; an agent that says nothing is trusted, one that says no is not.
    this.imagesSupported = !(isRecord(caps.promptCapabilities) && caps.promptCapabilities.image === false);
    // Private MCP servers (spec 2026-10-07-private-project-mcp) ride ACP's per-session list.
    const { mcpServers, skipped } = toAcpMcpServers(this.spec.mcpServers ?? [], acpMcpCapabilities(init));
    if (skipped.length) {
      this.emit({ type: 'note', message: skippedServersNote('kimi', skipped, 'the CLI did not advertise that MCP transport') });
    }
    this.noteUnenforceableTools();

    const base = {
      cwd: this.spec.cwd,
      mcpServers,
      ...(this.spec.additionalDirectories?.length ? { additionalDirectories: this.spec.additionalDirectories } : {}),
    };
    let configOptions: unknown;
    if (this.spec.resume && this.spec.sessionId) {
      try {
        const res = await this.request('session/resume', { sessionId: this.spec.sessionId, ...base }, handshake);
        this.sessionId = this.spec.sessionId;
        configOptions = res.configOptions;
      } catch (err) {
        if (this.closedReason !== null) throw err;
        // Kimi forgot the session (another home, a cleared log): Continue still runs, from scratch.
        this.emit({
          type: 'note',
          message: `Kimi could not resume session ${this.spec.sessionId} (${err instanceof Error ? err.message : String(err)}) — starting a fresh session`,
        });
      }
    }
    if (!this.sessionId) {
      const res = await this.request('session/new', base, handshake);
      this.sessionId = typeof res.sessionId === 'string' ? res.sessionId : undefined;
      configOptions = res.configOptions;
    }
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error('kimi acp returned no session id');
    this.emit({ type: 'session', sessionId });
    const logHome = kimiLogHome(this.launcher, this.env);
    this.usage = logHome ? new KimiUsageReader(logHome, sessionId) : undefined;

    const model = this.spec.model?.trim();
    if (model && selectValue(configOptions, 'model') !== model) {
      const offered = selectOptions(configOptions, 'model');
      if (offered.length > 0 && !offered.includes(model)) {
        throw new Error(`kimi: model "${model}" is not offered by this Kimi account (available: ${offered.join(', ')})`);
      }
      const res = await this.request('session/set_config_option', { sessionId, configId: 'model', value: model }, handshake);
      configOptions = res.configOptions ?? configOptions;
    }
    this.emitUi((state) => kimiSessionStarted(state, sessionId, configOptions));

    this.prompt(
      this.toAcp([
        ...(this.spec.images ?? []),
        { type: 'text', text: prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt) },
      ]),
    );
  }

  /** A step that excludes a tool Kimi never asks about must not look sandboxed. */
  private noteUnenforceableTools(): void {
    const allowed = this.spec.allowedTools;
    if (!allowed || allowed.length === 0) return;
    const unenforced = [...ALLOWLISTABLE_TOOLS].filter((tool) => !PERMISSION_GATED_TOOLS.has(tool) && !allowed.includes(tool));
    if (unenforced.length === 0) return;
    this.emit({
      type: 'note',
      message: `kimi: allowedTools cannot keep ${unenforced.join(', ')} out — Kimi runs them without asking permission (only Bash can be denied)`,
    });
  }

  /** Start one turn. Its response arrives in `handle`. */
  private prompt(prompt: AcpBlock[]): void {
    if (!this.sessionId || !this.stdinOpen || this.closedReason !== null) return;
    this.opened = true;
    this.emitUi((state) => kimiTurnStarted(state));
    const id = this.nextId++;
    this.promptId = id;
    // Settled in `handle`, which must see the response BEFORE anything else does; a lost
    // transport is settled by the lifecycle, which knows why the agent went away.
    this.pending.set(id, { resolve: () => undefined, reject: () => undefined });
    this.write({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: this.sessionId, prompt } });
  }

  private async handle(msg: RpcMessage): Promise<void> {
    // Agent → client request: a permission prompt, or something cezar does not serve.
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.answerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.id === 'number' && msg.id === this.promptId) {
      // The turn is over. Its token usage lives in Kimi's session log, not on this wire: feed it
      // to the mapper first, so `turn.completed` carries the turn's counts.
      this.promptId = undefined;
      this.pending.delete(msg.id);
      this.turnsAnswered += 1;
      for (const record of await this.usageRecords()) this.emitUi((state) => mapKimiMessage(record, state));
      this.emitUi((state) => mapKimiMessage(msg, state));
      this.afterTurn();
      return;
    }
    // A handshake response settles its request — and only that: its error is the session's
    // failure, reported once by the lifecycle, not a second time by the mapper.
    if (msg.id !== undefined && msg.method === undefined) {
      this.dispatchResponse(msg);
      return;
    }
    this.emitUi((state) => mapKimiMessage(msg, state));
  }

  private async usageRecords(): Promise<unknown[]> {
    if (!this.usage) return [];
    const records: unknown[] = [];
    const deadline = Date.now() + USAGE_SETTLE_MAX_MS;
    for (;;) {
      const read = this.usage.read();
      records.push(...read.records);
      if (read.turnEnded || Date.now() >= deadline) return records;
      await new Promise((resolve) => setTimeout(resolve, USAGE_POLL_MS));
    }
  }

  private afterTurn(): void {
    if (!this.stdinOpen) return;
    if (this.queued.length > 0) {
      const blocks = this.toAcp(this.queued.splice(0).flat());
      if (blocks.length > 0) {
        this.prompt(blocks);
        return;
      }
    }
    if (this.opts.autoEndAfterFirstTurn && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
      this.autoEndTimer.unref?.();
    }
  }

  /** cezar content → ACP prompt blocks. Consecutive texts (queued follow-ups) merge into one. */
  private toAcp(content: ContentBlock[]): AcpBlock[] {
    const blocks: AcpBlock[] = [];
    let dropped = 0;
    for (const block of content) {
      if (block.type === 'image') {
        if (this.imagesSupported) blocks.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
        else dropped += 1;
        continue;
      }
      if (!block.text) continue;
      const last = blocks.at(-1);
      if (last?.type === 'text') last.text = `${last.text}\n\n${block.text}`;
      else blocks.push({ type: 'text', text: block.text });
    }
    if (dropped > 0) this.emit({ type: 'note', message: `kimi does not accept images; dropped ${dropped}` });
    return blocks;
  }

  private answerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method !== 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `cezar does not serve ${method}` } });
      return;
    }
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const tool = typeof toolCall.title === 'string' ? toolCall.title : '';
    const denied = this.deniedReason(tool);
    const pick = denied
      ? options.find((o) => o.kind === 'reject_once') ?? options.find((o) => String(o.kind).startsWith('reject'))
      : options.find((o) => o.kind === 'allow_once') ?? options.find((o) => String(o.kind).startsWith('allow'));
    if (denied) this.emit({ type: 'note', message: `kimi: denied ${tool} — ${denied}` });
    const outcome =
      pick && typeof pick.optionId === 'string' ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
    this.write({ jsonrpc: '2.0', id, result: { outcome } });
  }

  private deniedReason(tool: string): string | undefined {
    if (!ALLOWLISTABLE_TOOLS.has(tool)) return undefined;
    const allowed = this.spec.allowedTools;
    if (allowed && allowed.length > 0 && !allowed.includes(tool)) return 'not in this step\'s allowedTools';
    if (tool === 'Bash' && this.spec.bashAllowlist && this.spec.bashAllowlist.length > 0) {
      return 'Kimi cannot enforce a bashAllowlist prefix, so Bash is off for this step';
    }
    return undefined;
  }

  private request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) return Promise.reject(new Error(this.closedReason));
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      if (options.timeoutMs && options.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`kimi: ${method} got no answer within ${formatMs(options.timeoutMs!)}`));
        }, options.timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private dispatchResponse(msg: RpcMessage): void {
    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.error !== undefined) pending.reject(new Error(`kimi: ${errorText(msg.error)}`));
    else pending.resolve(isRecord(msg.result) ? msg.result : {});
  }

  /** The agent's output is gone: nothing can answer a waiting request any more. Idempotent. */
  private close(reason: string): void {
    this.closedReason ??= reason;
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(new Error(this.closedReason));
    }
    this.pending.clear();
  }

  private write(message: unknown): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // the read/exit path owns settlement
    }
  }

  // ---- teardown -----------------------------------------------------------

  private closeStdin(): void {
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
  }

  /** SIGTERM now, SIGKILL if that is ignored — once, however many paths ask. Through the
   *  launcher, so a containerized agent is reached rather than just its client. */
  private escalate(): void {
    if (this.killEscalated) return;
    this.killEscalated = true;
    this.signal('SIGTERM');
    this.after(EOF_KILL_GRACE_MS, () => this.signal('SIGKILL'));
  }

  private signal(sig: NodeJS.Signals): void {
    if (this.hasExited()) return;
    this.terminatedByCezar = true;
    void this.launcher.signal(this.child, sig).catch(() => undefined);
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  // ---- emission -----------------------------------------------------------

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** Map into v2, and derive the v1 stream from the same mapped events so the two cannot drift. */
  private emitUi(step: (state: KimiUiMapperState) => KimiUiMapping): void {
    const mapped = step(this.uiState);
    this.uiState = mapped.state;
    for (const event of mapped.events) {
      this.opts.onUiEvent?.(event);
      this.emitV1(event);
    }
  }

  private emitV1(event: UiEvent): void {
    switch (event.type) {
      case 'item.updated':
        if (event.item.kind === 'tool' && event.item.input !== undefined) this.announceTool(event.item);
        return;
      case 'item.completed':
        if (event.item.kind === 'message' && event.item.text.trim()) {
          this.textChunks.push(event.item.text);
          this.emit({ type: 'text', text: event.item.text });
        } else if (event.item.kind === 'tool') {
          this.announceTool(event.item);
          this.emit({
            type: 'tool-result',
            toolCallId: event.item.id,
            result: event.item.output ?? event.item.error ?? '',
            isError: event.item.status === 'failed',
          });
        }
        return;
      case 'usage.updated': {
        const u = event.usage;
        this.tokensUsed = costWeightedTokens({
          input_tokens: u.input,
          output_tokens: u.output,
          cache_read_input_tokens: u.cacheRead,
          cache_creation_input_tokens: u.cacheWrite,
        });
        this.emit({ type: 'token-usage', tokensUsed: this.runTokens + this.tokensUsed });
        return;
      }
      case 'turn.completed':
        this.lastStopReason = event.stopReason;
        this.runTokens += this.tokensUsed;
        this.tokensUsed = 0;
        this.emit({ type: 'turn-end' });
        return;
      case 'session.error':
        this.emit({ type: 'error', message: event.message });
        return;
      default:
        return;
    }
  }

  private announceTool(item: UiToolItem): void {
    if (this.announced.has(item.id)) return;
    this.announced.add(item.id);
    this.toolCalls.push({ id: item.id, name: item.name, input: item.input });
    this.emit({ type: 'tool-call', id: item.id, tool: item.name, input: item.input });
  }
}

/**
 * Reads new `usage.record` lines from Kimi's own session log:
 * `<KIMI_CODE_HOME>/sessions/<workdir-key>/<sessionId>/agents/<agent>/wire.jsonl`, one file per
 * agent (`main`, plus one per sub-agent — their tokens are spent on this run too). The workdir
 * key is Kimi's private hash of the cwd, so the session dir is FOUND by its id rather than
 * derived. Each file is read from where the last read stopped; on a resumed session the first
 * read starts at the current end, so earlier turns are not billed again.
 *
 * Never throws: a missing or unreadable log means a turn without usage, not a failed run.
 */
export class KimiUsageReader {
  private sessionDir: string | undefined;
  private readonly offsets = new Map<string, number>();
  private primed = false;

  constructor(
    private readonly home: string,
    private readonly sessionId: string,
  ) {
    this.prime();
  }

  /** New usage records since the last read, and whether the main agent's turn has ended. */
  read(): { records: unknown[]; turnEnded: boolean } {
    const records: unknown[] = [];
    let turnEnded = false;
    try {
      const dir = this.locate();
      // No log at all (another home, a mock): nothing will arrive by waiting for it.
      if (!dir) return { records, turnEnded: true };
      const agentsDir = join(dir, 'agents');
      for (const agent of readdirSync(agentsDir)) {
        const file = join(agentsDir, agent, 'wire.jsonl');
        if (!existsSync(file)) continue;
        const text = this.readNewLines(file);
        if (!text) continue;
        for (const line of text.split('\n')) {
          // Cheap prefilter (most lines are tool output); the decision is the parsed `type`.
          if (!line.includes('usage.record') && !line.includes('turn.ended')) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue; // a torn line is skipped, never fatal
          }
          if (!isRecord(value)) continue;
          if (value.type === 'usage.record') records.push(value);
          else if (value.type === 'turn.ended' && agent === 'main') turnEnded = true;
        }
      }
    } catch {
      // degrade: no usage for this turn
    }
    return { records, turnEnded };
  }

  /**
   * The whole lines appended to `file` since the last read. Offsets are BYTES — what `stat`
   * reports and what the file holds — and only from the offset is read, so a 50ms poll does not
   * re-read a growing log, and a multi-byte character never shifts where the next read starts.
   * A half-written trailing line is left for the next read.
   */
  private readNewLines(file: string): string | undefined {
    let from = this.offsets.get(file) ?? 0;
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size < from) from = 0; // rewritten from scratch: start over
      if (size <= from) return undefined;
      const buffer = Buffer.alloc(size - from);
      let filled = 0;
      while (filled < buffer.length) {
        const n = readSync(fd, buffer, filled, buffer.length - filled, from + filled);
        if (n === 0) break;
        filled += n;
      }
      const end = buffer.subarray(0, filled).lastIndexOf(0x0a) + 1;
      if (end === 0) return undefined;
      this.offsets.set(file, from + end);
      return buffer.subarray(0, end).toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  /** Records what already exists, so a resumed session counts only its new turns. */
  private prime(): void {
    if (this.primed) return;
    this.primed = true;
    try {
      const dir = this.locate();
      if (!dir) return;
      const agentsDir = join(dir, 'agents');
      for (const agent of readdirSync(agentsDir)) {
        const file = join(agentsDir, agent, 'wire.jsonl');
        if (existsSync(file)) this.offsets.set(file, statSync(file).size);
      }
    } catch {
      // nothing to prime
    }
  }

  private locate(): string | undefined {
    if (this.sessionDir) return this.sessionDir;
    const sessions = join(this.home, 'sessions');
    if (!existsSync(sessions)) return undefined;
    for (const workdir of readdirSync(sessions)) {
      const candidate = join(sessions, workdir, this.sessionId);
      if (existsSync(candidate)) {
        this.sessionDir = candidate;
        return candidate;
      }
    }
    return undefined;
  }
}


/**
 * Where THIS session's log lands, seen from the host. Locally that is Kimi's own home; in a podman
 * container it is the (per-project) agent home mounted at `/root/.kimi-code`. Any other launcher has no host
 * view of the log, so its turns simply carry no usage.
 */
function kimiLogHome(launcher: ProcessLauncher, env: NodeJS.ProcessEnv): string | undefined {
  if (launcher.id === 'local') return kimiHome(env);
  if (launcher.id === 'podman') {
    // Per-project agent homes, when the launcher carries them; the shared one otherwise.
    return launcher.agentHomes?.kimi ?? agentKimiHome();
  }
  return undefined;
}

function selectOptions(configOptions: unknown, id: string): string[] {
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.find((o) => isRecord(o) && o.id === id);
  if (!isRecord(option) || !Array.isArray(option.options)) return [];
  return option.options.flatMap((o) => (isRecord(o) && typeof o.value === 'string' ? [o.value] : []));
}

function selectValue(configOptions: unknown, id: string): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((o) => isRecord(o) && o.id === id);
  return isRecord(option) && typeof option.currentValue === 'string' ? option.currentValue : undefined;
}

/** Armed at spawn, so a `close` that fires before the lifecycle asks is never missed. */
function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(child.exitCode ?? null));
  });
}

export function kimiSpawnError(error: unknown, bin: string): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new Error(`\`${bin}\` not found on PATH — install Kimi Code and run \`kimi login\``);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function errorText(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    // An ACP internal error keeps its useful part in `data.details` ("Unknown sessionId: …").
    const details = isRecord(error.data) && typeof error.data.details === 'string' ? error.data.details : undefined;
    return details ? `${error.message}: ${details}` : error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Path to the bundled mock (`scripts/mock-kimi-acp.mjs`), for CEZ_DRY_RUN=1. */
function mockKimiPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-kimi-acp.mjs');
}

function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${Math.round(ms / 1_000)}s`;
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
