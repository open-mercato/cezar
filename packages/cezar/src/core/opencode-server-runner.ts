import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentToolCallRecord,
  ContentBlock,
} from './agent-runner.ts';
import type { AgentSession, SessionOptions } from './agent-runner.ts';
import { prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { translateOpencodePermissions, type PermissionSpec } from './permission-map.ts';
import { opencodePermissionResponse } from './permission-prompt.ts';
import { buildChildEnv } from './agent-env.ts';
import { AUTO_END_DELAY_MS, DEFAULT_RUN_TIMEOUT_MS } from './claude-cli-runner.ts';
import { parseModelIdentity } from './model-identity.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import {
  OpencodeTransportError,
  openOpencodeEventStream,
  opencodeRequest,
} from './opencode-http.ts';
import {
  createOpencodeUiState,
  mapOpencodeEvent,
  opencodeSessionStarted,
  opencodeTurnStarted,
  type OpencodeUiMapperState,
  type OpencodeUiMapping,
} from './opencode-ui-mapper.ts';

export interface OpencodeRunnerOptions {
  /** Override the binary name/path; defaults to `opencode` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

const SERVER_START_TIMEOUT_MS = 30_000;

/** Grace between the teardown SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 4_000;

/**
 * How long a turn waits for a `session.idle` that never comes, once the prompt
 * POST has settled and the event bus has gone quiet.
 *
 * `session.idle` is the turn boundary (#897), and the window below is the
 * transition out of the state that signal would otherwise be the only exit
 * from: an opencode build that does not emit it still ends its turn. Every
 * `message.*` frame re-arms the window, so a session that is genuinely working
 * — the case this whole fix is about — never trips it. This is NOT the
 * configurable agent-step wall clock (#880); that deadline is untouched.
 */
export const TURN_IDLE_GRACE_MS = 5_000;

/**
 * `AgentRunner` over `opencode serve` — a headless HTTP server (the same one
 * the opencode TUI talks to) with an SSE event stream. One server per session,
 * bound to the run's `cwd` (worktree), gives OpenCode the same multi-turn shape
 * as the Claude runner: each `sendMessage` posts another prompt to the same
 * session (history is kept server-side) and `session/abort` cancels. "Continue"
 * starts a fresh server and a fresh session — `bootstrap()` always `POST
 * /session` and does not read `spec.sessionId`; resuming a server-side session
 * id is not implemented.
 *
 * Auth = the host's opencode config/logins. The agent runs autonomously
 * (auto-approved permissions); OpenCode has no per-tool allowlist, so
 * `spec.allowedTools` is ignored. `spec.model` is `provider/model`.
 */
export class OpencodeServerRunner implements AgentRunner {
  readonly backend = 'opencode' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: OpencodeSession | null = null;

  constructor(opts: OpencodeRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_OPENCODE_BIN ?? 'opencode';
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
    const session = new OpencodeSession(this.bin, this.timeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

/** One live `opencode serve` process driving a single session. */
class OpencodeSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  /** "Has the server actually terminated?" — never `child.killed`, which only
   *  reports delivery and would disarm the escalation (#844/#858). */
  private readonly hasExited: () => boolean;
  private serverOpen = true;
  private baseUrl: string | undefined;
  private sessionId: string | undefined;
  private ready!: Promise<void>;
  private resolveExit!: () => void;
  private exited!: Promise<void>;
  private readonly sse = new AbortController();
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  /** Per text-part cursor so only newly-appended text is buffered (deltas). */
  private readonly textSeen = new Map<string, number>();
  /** Streamed part deltas buffered per part — v1 `text` is emitted once per
   *  finished part (claude parity: one event per complete block), never per
   *  delta, so the persisted transcript and the headless CLI get whole
   *  paragraphs. Streaming display rides protocol v2's `item.delta`. */
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private readonly toolsSeen = new Set<string>();
  /** messageID → role. Parts carry no role; only assistant parts are surfaced
   *  (the user's own message also streams as parts over the same SSE feed). */
  private readonly msgRole = new Map<string, string>();
  private tokensUsed = 0;
  private lastCost = 0;
  private turnInFlight = false;
  /** Has this turn's prompt POST settled (either way)? Until it has, nothing
   *  synthesizes a turn end — only the wire does. */
  private turnPostSettled = false;
  /** Resolves the in-flight turn's `prompt()` — called from `finishTurn()`. */
  private endTurn: (() => void) | undefined;
  private turnGraceTimer: NodeJS.Timeout | undefined;
  /** A transport drop swallowed during this turn (#897), kept so a turn that
   *  then ends WITHOUT a `session.idle` still reports it. Dropping the POST is
   *  no evidence on its own; dropping it AND never hearing the session finish
   *  is, and that must not disappear along with the false "Needs you". */
  private turnDropped: string | undefined;
  /** Did the SSE subscription ever connect, and is it still open? Together
   *  they answer "does the event bus still show a live session?" — the
   *  question that decides whether a dropped prompt POST means anything. */
  private sseConnected = false;
  private sseClosed = false;
  /** Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
   *  byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
   *  lands in R2 step 2.1). Both streams now take their turn end from the wire
   *  `session.idle`; v1's used to be synthesized from the HTTP response. */
  private uiState: OpencodeUiMapperState = createOpencodeUiState();
  private autoEndTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** One teardown per session — see `terminate()`. */
  private signalled = false;

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    // Random high port; the actual bound URL is read back from stdout.
    const port = 40000 + Math.floor(Math.random() * 20000);
    try {
      this.child = nodeSpawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: 'opencode', extraEnv: spec.env }),
      });
    } catch (err) {
      throw wrapSpawnError(err, bin);
    }
    this.hasExited = trackChildExit(this.child);

    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed = wrapSpawnError(err, bin);
    });

    this.exited = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    // A server that is gone will never send `session.idle`, so the turn ends
    // here rather than waiting for a signal that cannot arrive.
    this.child.once('exit', () => {
      this.finishTurn();
      this.resolveExit();
    });
    this.child.once('close', () => {
      this.finishTurn();
      this.resolveExit();
    });

    const stderrChunks: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // The server prints its URL on stdout once listening.
    const urlReady = this.waitForServerUrl(port);

    const limitMs = spec.timeoutMs ?? timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, limitMs);
      deadline.unref?.();
    }

    this.ready = (async () => {
      this.baseUrl = await urlReady;
      await this.bootstrap();
    })();

    this.result = (async (): Promise<AgentRunResult> => {
      try {
        await this.ready;
        // Live for the whole session; the SSE loop runs until end()/interrupt.
        await this.exited;
      } catch (err) {
        if (!this.timedOut) {
          const message = err instanceof Error ? err.message : String(err);
          this.emit({ type: 'error', message: `opencode: ${message}` });
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.sse.abort();
        this.serverOpen = false;
        this.terminate();
      }

      await this.exited;
      if (this.spawnFailed) throw this.spawnFailed;

      // Timeout/interrupt can cut the SSE feed mid-part — recover buffered prose.
      this.textCoalescer.flush();
      // Chunks are whole blocks now (one per finished part), so newline-join
      // like the other runners, not the old delta concatenation.
      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.sessionId ?? spec.sessionId,
      };
      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `opencode timed out after ${mins}m and was killed` });
      }
      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.serverOpen;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.serverOpen) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const text = textOf(content);
    if (!text) return true;
    void this.ready
      .then(() => this.prompt(text))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'note', message: `opencode: prompt failed: ${message}` });
      });
    return true;
  }

  end(): void {
    if (!this.serverOpen) return;
    this.serverOpen = false;
    this.finishTurn();
    this.sse.abort();
    this.terminate();
  }

  interrupt(): void {
    this.serverOpen = false;
    if (this.baseUrl && this.sessionId) {
      void this.http('POST', `/session/${this.sessionId}/abort`, undefined).catch(() => undefined);
    }
    this.finishTurn();
    this.sse.abort();
    this.terminate();
  }

  /**
   * Answer a pending OpenCode permission prompt (#475).
   * `POST /session/:id/permissions/:permissionID` with `{response: once|always|reject}`.
   */
  async respondPermission(requestId: string, optionId: string): Promise<boolean> {
    if (!this.serverOpen || !this.baseUrl || !this.sessionId) return false;
    const response = opencodePermissionResponse(optionId);
    if (response === undefined) return false;
    try {
      await this.http('POST', `/session/${this.sessionId}/permissions/${encodeURIComponent(requestId)}`, {
        response,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The one place either signal is sent: SIGTERM now, SIGKILL once the grace
   * window elapses.
   *
   * Both steps gate on `hasExited()`, never on `child.killed` — the latter
   * flips the moment SIGTERM is *delivered*, so the old nested
   * `exitCode == null && !killed` guard disarmed the escalation for exactly the
   * server it was written for: one that installs its own SIGTERM handler stayed
   * alive with `killed = true` and `exitCode === null`, outliving the whole
   * window (#858, the same defect #844 fixed for the other two backends). Every
   * caller here is followed by `await this.exited`, so a server that survived
   * SIGTERM did not just leak — it hung the session's result forever.
   *
   * One teardown per session: all three call sites can run for the same session
   * (`interrupt()` on the deadline, then the result promise's `finally`), and
   * once SIGTERM is out with SIGKILL armed there is nothing a second pass adds.
   * The old `!child.killed` test deduplicated this as a side effect of being
   * wrong; `signalled` keeps that property on purpose.
   */
  private terminate(): void {
    if (this.signalled || this.hasExited()) return;
    this.signalled = true;
    this.child.kill('SIGTERM');
    setTimeout(() => {
      if (this.hasExited()) return;
      this.child.kill('SIGKILL');
    }, KILL_GRACE_MS).unref?.();
  }

  // ---- server lifecycle ---------------------------------------------------

  private waitForServerUrl(fallbackPort: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        // Nothing parsed — try the port we asked for.
        resolve(`http://127.0.0.1:${fallbackPort}`);
      }, SERVER_START_TIMEOUT_MS);
      timer.unref?.();
      const onData = (chunk: string) => {
        buffer += chunk;
        const m = /https?:\/\/[\d.]+:\d+/.exec(buffer);
        if (m) {
          cleanup();
          resolve(m[0]);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error('opencode serve exited before it started listening'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.child.stdout.off('data', onData);
        this.child.off('exit', onExit);
      };
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', onData);
      this.child.once('exit', onExit);
    });
  }

  private async bootstrap(): Promise<void> {
    // Translate permissions (spec 2026-07-17-permission-modes, #475).
    const effectivePermSpec: PermissionSpec = this.spec.permissions ?? { mode: 'auto' };
    const opencodePerm = translateOpencodePermissions(effectivePermSpec);
    if (opencodePerm.engineNote) {
      this.emit({ type: 'note', message: opencodePerm.engineNote });
    }
    const sessionBody: Record<string, unknown> = { title: 'cezar task' };
    // OpenCode ≥1.18: `permission` must be a Ruleset array
    // (`{ permission, pattern, action }[]`). Object syntax 400s.
    if (opencodePerm.permissions.length > 0) {
      sessionBody.permission = opencodePerm.permissions;
    }
    const created = await this.http('POST', '/session', sessionBody);
    this.sessionId = stringField(created, 'id');
    if (!this.sessionId) throw new Error('opencode did not return a session id');
    this.emit({ type: 'session', sessionId: this.sessionId });
    const sessionId = this.sessionId;
    this.emitUi((state) => opencodeSessionStarted(sessionId, state));

    // The SSE subscription must be LIVE before the first prompt posts —
    // events the server emits while the POST is in flight would otherwise be
    // lost (a race this await closes; the bundled mock made it visible).
    await this.consumeEvents();

    const first = prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt);
    await this.prompt(first);
  }

  /**
   * Post one prompt and resolve when the TURN ends — not when the HTTP
   * response does.
   *
   * Opencode holds `POST /session/:id/message` open for the whole turn, so the
   * response is neither a reliable nor a timely boundary: it lands before the
   * final text part (the bundled mock exists to pin that ordering), and when
   * the transport drops it mid-turn the turn has not ended at all. Reading it
   * as the boundary is what parked live runs under "Needs you" at exactly 5:00
   * (#897). The end comes from the wire `session.idle`, the same signal v2 has
   * always used, with `armTurnGrace()` as the bounded way out when no such
   * signal is coming.
   */
  private async prompt(text: string): Promise<void> {
    if (!this.sessionId) return;
    // A prompt posted while a turn is still in flight supersedes it — the
    // cockpit lets a user type into a running task (#986), so this is reachable.
    // Close the old turn here or its `await turnEnded` never resolves, and with
    // it the `sendMessage`/`bootstrap` call that is waiting on it.
    this.finishTurn();
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    this.turnInFlight = true;
    this.turnPostSettled = false;
    this.turnDropped = undefined;
    const turnEnded = new Promise<void>((resolve) => {
      this.endTurn = resolve;
    });
    // v2 turn boundary — the prompt POST is the turn start (§7.1).
    this.emitUi(opencodeTurnStarted);
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
    // `spec.model` arrives already normalised to canonical `provider/model`
    // (the run wiring's fail-loud gate). Split it with the shared parser — the
    // one every runner uses — into opencode's `{ providerID, modelID }`.
    const id = parseModelIdentity(this.spec.model);
    if (id) body.model = { providerID: id.provider, modelID: id.model };
    let failure: unknown;
    try {
      const res = await this.http('POST', `/session/${this.sessionId}/message`, body);
      this.absorbUsage(res);
    } catch (err) {
      // A transport drop on a session the event bus still shows alive is no
      // evidence about the agent — swallow it and keep listening. Anything
      // else (an HTTP status, a dead server) is a real failure and is raised
      // to the caller exactly as before.
      if (this.isDropWhileSessionLives(err)) {
        this.turnDropped = err instanceof Error ? err.message : String(err);
      } else {
        failure = err;
      }
    }
    this.turnPostSettled = true;
    if (failure !== undefined) {
      this.finishTurn();
      throw failure;
    }
    this.armTurnGrace();
    await turnEnded;
  }

  /**
   * End the in-flight turn, once. The single place `turn-end` is emitted, so
   * every exit — `session.idle`, the grace window, teardown, a server that
   * exited — produces exactly one.
   *
   * `fromIdle` marks the one exit that is the session's own word for "the turn
   * is over". Every other exit is cezar synthesizing a boundary, and if the
   * POST also dropped during this turn that drop was never explained: report it
   * then, so a server that really did die does not go quiet just because #897
   * stopped a live one from being parked.
   */
  private finishTurn(fromIdle = false): void {
    if (!this.turnInFlight) return;
    this.turnInFlight = false;
    if (this.turnGraceTimer) {
      clearTimeout(this.turnGraceTimer);
      this.turnGraceTimer = undefined;
    }
    const dropped = this.turnDropped;
    this.turnDropped = undefined;
    // A part that never saw `time.end` (abort, server quirk) still surfaces
    // its prose before the turn boundary (run.ts reads markers there).
    this.textCoalescer.flush();
    if (dropped !== undefined && !fromIdle) {
      this.emit({ type: 'note', message: `opencode: prompt failed: ${dropped}` });
    }
    this.emit({ type: 'turn-end' });
    if (this.opts.autoEndAfterFirstTurn && this.serverOpen && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
      this.autoEndTimer.unref?.();
    }
    const resolve = this.endTurn;
    this.endTurn = undefined;
    resolve?.();
  }

  /**
   * Arm (or re-arm) the wait for a `session.idle` that may never come. Only
   * meaningful once the POST has settled — before that the turn is plainly
   * still running. With no event bus to listen to there is nothing to wait
   * for, so the HTTP response stays the boundary, exactly as it was.
   */
  private armTurnGrace(): void {
    if (!this.turnInFlight || !this.turnPostSettled) return;
    if (this.turnGraceTimer) {
      clearTimeout(this.turnGraceTimer);
      this.turnGraceTimer = undefined;
    }
    if (!this.sseConnected || this.sseClosed) {
      this.finishTurn();
      return;
    }
    this.turnGraceTimer = setTimeout(() => this.finishTurn(), TURN_IDLE_GRACE_MS);
    this.turnGraceTimer.unref?.();
  }

  /** Did the prompt POST drop on a session the event bus still shows alive? */
  private isDropWhileSessionLives(err: unknown): boolean {
    // An HTTP status is an answer from the server, not a lost connection.
    if (!(err instanceof OpencodeTransportError)) return false;
    if (!this.serverOpen || this.hasExited()) return false;
    return this.sseConnected && !this.sseClosed;
  }

  // ---- SSE stream ---------------------------------------------------------

  /** Resolves once the SSE stream is CONNECTED (headers in) — the frames are
   *  then drained in the background. Callers await the connection so no
   *  event emitted after this resolves can be missed. */
  private async consumeEvents(): Promise<void> {
    if (!this.baseUrl) return;
    this.sseConnected = await openOpencodeEventStream(`${this.baseUrl}/event`, {
      signal: this.sse.signal,
      onFrame: (frame) => this.handleFrame(frame),
      // The bus is the turn's evidence of life; once it is gone a turn waiting
      // on `session.idle` would wait forever.
      onClose: () => {
        this.sseClosed = true;
        this.armTurnGrace();
      },
    });
  }

  private handleFrame(frame: string): void {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    let evt: OpencodeEvent;
    try {
      evt = JSON.parse(dataLines.join('\n')) as OpencodeEvent;
    } catch {
      return;
    }
    this.emitUi((state) => mapOpencodeEvent(evt, state));
    this.handleEvent(evt);
  }

  private handleEvent(evt: OpencodeEvent): void {
    const type = evt.type ?? '';
    const props = evt.properties ?? {};
    if (type === 'message.updated' || type === 'message.created' || type === 'message.completed') {
      const info = (props.info as Record<string, unknown>) ?? props;
      const mid = stringField(info, 'id');
      const role = stringField(info, 'role');
      if (mid && role) this.msgRole.set(mid, role);
      this.absorbUsage(info);
      this.armTurnGrace();
    } else if (type === 'message.part.updated' || type === 'message.part.created') {
      this.handlePart((props.part as Record<string, unknown>) ?? props);
      this.armTurnGrace();
    } else if (type === 'session.idle') {
      // The turn boundary (#897). A subtask session going idle closes only its
      // own scope, exactly as the v2 mapper reads it.
      const sid = stringField(props, 'sessionID');
      if (sid === undefined || sid === this.sessionId) this.finishTurn(true);
    }
  }

  private handlePart(part: Record<string, unknown>): void {
    // Only surface parts of assistant messages — the user's own message streams
    // over the same feed. Role is known early (the message.updated event
    // precedes its parts); an unknown role means "not assistant yet" → skip.
    const messageID = stringField(part, 'messageID');
    if (messageID && this.msgRole.get(messageID) !== 'assistant') return;
    const kind = stringField(part, 'type');
    const id = stringField(part, 'id') ?? messageID ?? '';
    if (kind === 'text') {
      const full = stringField(part, 'text') ?? '';
      const seen = this.textSeen.get(id) ?? 0;
      if (full.length > seen) {
        this.textSeen.set(id, full.length);
        this.textCoalescer.append(id, full.slice(seen));
      }
      // `time.end` marks the part finished (same signal the v2 mapper uses) —
      // emit the whole block once, preferring the snapshot's full text.
      const time = part.time as Record<string, unknown> | undefined;
      if (time && typeof time === 'object' && typeof time.end === 'number') {
        this.textCoalescer.complete(id, full);
      }
    } else if (kind === 'tool') {
      const state = (part.state as Record<string, unknown> | undefined) ?? {};
      const status = stringField(state, 'status');
      const name = stringField(part, 'tool') ?? stringField(part, 'name') ?? 'tool';
      const callId = id || `${name}-${this.toolsSeen.size}`;
      if (!this.toolsSeen.has(callId)) {
        this.toolsSeen.add(callId);
        this.toolCalls.push({ id: callId, name, input: state.input ?? state });
        this.emit({ type: 'tool-call', id: callId, tool: name, input: state.input ?? state });
      }
      if (status === 'completed' || status === 'error') {
        this.emit({
          type: 'tool-result',
          toolCallId: callId,
          result: safeStringify(state.output ?? state.result ?? state),
          isError: status === 'error',
        });
      }
    }
  }

  /** Pull cumulative tokens/cost out of an assistant message info object. */
  private absorbUsage(info: Record<string, unknown> | undefined): void {
    if (!info) return;
    const tokens = info.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      const input = numField(tokens, 'input');
      const output = numField(tokens, 'output');
      const reasoning = numField(tokens, 'reasoning');
      const total = input + output + reasoning;
      if (total > this.tokensUsed) {
        this.tokensUsed = total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
      }
    }
    const cost = numField(info, 'cost');
    if (cost > this.lastCost) {
      this.emit({ type: 'cost', usd: cost - this.lastCost });
      this.lastCost = cost;
    }
  }

  // ---- http ---------------------------------------------------------------

  /**
   * One call to the server. Goes through `opencode-http.ts` rather than the
   * global `fetch` so no undici `headersTimeout`/`bodyTimeout` default cuts the
   * prompt long-poll at 300 s (#897) — see that module's header for why.
   *
   * Rejects with `OpencodeTransportError` when the connection failed and a
   * plain `Error` when the server answered with a status; only the caller can
   * tell whether the first of those means anything.
   */
  private async http(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.baseUrl) throw new Error('opencode server not ready');
    const res = await opencodeRequest(`${this.baseUrl}${path}`, { method, body });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${method} ${path} → ${res.status} ${res.body.slice(0, 200)}`);
    }
    if (!res.body) return {};
    try {
      return JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: OpencodeUiMapperState) => OpencodeUiMapping): void {
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

interface OpencodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install OpenCode (https://opencode.ai) and run \`opencode\` once to configure a provider`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
