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
import { buildChildEnv } from './agent-env.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
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
import { OpencodeV2Translator, type OpencodeEvent } from './opencode-v2-events.ts';

export interface OpencodeRunnerOptions {
  /** Override the binary name/path; defaults to `opencode` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

const SERVER_START_TIMEOUT_MS = 30_000;

/** How long startup keeps watching for the password line after the URL
 *  appears. A password-protected 2.x prints both in the same instant; a
 *  server without auth prints only the URL and must not pay the full start
 *  timeout for a line that will never come. */
const PASSWORD_LINE_GRACE_MS = 600;

/** Grace between the teardown SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 4_000;

/**
 * How long a turn waits for a `session.idle` that never comes, once the turn's
 * HTTP wait has settled and the event bus has gone quiet.
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
 * session (history is kept server-side) and `POST /api/session/:id/interrupt`
 * cancels. "Continue" starts a fresh server and a fresh session —
 * `bootstrap()` always `POST /api/session` and does not read `spec.sessionId`;
 * resuming a server-side session id is not implemented.
 *
 * The 2.x wire it speaks: Basic auth (`opencode:<password>`, the password the
 * server prints on stdout) over an `/api` prefix; the model is bound to the
 * SESSION (`{model:{providerID, id}}` at creation — the prompt body carries
 * none); a prompt is `POST .../prompt` (fast admission) followed by the
 * `POST /api/experimental/session/:id/wait` long poll, which answers when the
 * agent loop goes idle — v1 held the message POST open for the same span; and
 * the turn boundary arrives on the SSE bus as `session.execution.succeeded`,
 * which `OpencodeV2Translator` reshapes into the v1 `session.idle` both
 * consumers (#897 fix and protocol-v2 mapper) already read.
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
  /** The server password (2.x prints `server password <pw>` after its URL);
   *  sent as Basic auth on every call, including the SSE bus. Absent only on
   *  a server that printed none — then no auth header goes out either. */
  private password: string | undefined;
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
  private lastCost: number | undefined;
  private turnInFlight = false;
  /** Has this turn's HTTP wait (prompt + long poll) settled (either way)?
   *  Until it has, nothing synthesizes a turn end — only the wire does. */
  private turnPostSettled = false;
  /** Monotonic prompt counter — a prompt that was superseded mid-flight must
   *  not touch the newer turn's flags when its own requests finally settle. */
  private turnSeq = 0;
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
  /** 2.x → v1 frame reshaping, per session (buffers and role announcements
   *  are session-scoped — see `opencode-v2-events.ts`). */
  private readonly translator = new OpencodeV2Translator();
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
      const env = buildChildEnv({ backend: 'opencode', extraEnv: spec.env });
      const [file, argv] = disclaimedCommand(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], env);
      this.child = nodeSpawn(file, argv, { cwd: spec.cwd, env });
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
      const info = await urlReady;
      this.baseUrl = info.url;
      this.password = info.password;
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
      void this.http('POST', `/api/session/${this.sessionId}/interrupt`, undefined).catch(() => undefined);
    }
    this.finishTurn();
    this.sse.abort();
    this.terminate();
  }

  hardStop(): void {
    this.interrupt();
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

  /**
   * Watch the server's stdout for its bound URL — and, on 2.x, the password
   * it prints right behind it (`server listening on <url>`, then `server
   * password <pw>`, in the same instant). The password gates EVERY call
   * including the session create, so startup waits for the pair; a server
   * that prints no password (none of ours, but a config can disable auth)
   * gets a short grace after the URL instead of the full start timeout.
   */
  private waitForServerUrl(fallbackPort: number): Promise<ServerInfo> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let url: string | undefined;
      let password: string | undefined;
      let grace: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (): void => {
        if (settled || url === undefined) return;
        settled = true;
        cleanup();
        resolve(password === undefined ? { url } : { url, password });
      };
      const onData = (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        if (password === undefined) {
          const pm = /server password\s+(\S+)/.exec(buffer);
          if (pm) password = pm[1];
        }
        if (url === undefined) {
          const m = /https?:\/\/[\d.]+:\d+/.exec(buffer);
          if (!m) return;
          url = m[0];
          if (password !== undefined) return finish();
          grace = setTimeout(finish, PASSWORD_LINE_GRACE_MS);
          grace.unref?.();
          return;
        }
        if (password !== undefined) finish();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        if (url === undefined) {
          // Nothing parsed — try the port we asked for.
          settled = true;
          cleanup();
          resolve({ url: `http://127.0.0.1:${fallbackPort}` });
          return;
        }
        finish();
      }, SERVER_START_TIMEOUT_MS);
      timer.unref?.();
      const onExit = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('opencode serve exited before it started listening'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        this.child.stdout.off('data', onData);
        this.child.off('exit', onExit);
      };
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', onData);
      this.child.once('exit', onExit);
    });
  }

  private async bootstrap(): Promise<void> {
    const body: Record<string, unknown> = { title: 'cezar task' };
    // 2.x binds the model to the SESSION — the prompt body has no model
    // field (v1 sent `{providerID, modelID}` per message; 2.x's Model.Ref is
    // `{providerID, id}` at creation time). `spec.model` arrives already
    // normalised to canonical `provider/model` (the run wiring's fail-loud
    // gate) and is split with the shared parser every runner uses.
    const model = parseModelIdentity(this.spec.model);
    if (model) body.model = { providerID: model.provider, id: model.model };
    const created = await this.http('POST', '/api/session', body);
    this.sessionId = sessionIdFrom(created);
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
   * responses do.
   *
   * 2.x splits what v1 did in one held-open `POST /session/:id/message`:
   * `POST .../prompt` only ADMITS the input (it answers in ~0.5 s, before the
   * agent has produced anything), and `POST /api/experimental/session/:id/wait`
   * is the long poll that answers when the agent loop goes idle — tools and
   * all. That wait is the held-open request of this design: no client-side
   * timeout can cut it (it goes through `opencode-http.ts`'s `node:http`), a
   * transport drop mid-turn is the #897 shape and is treated exactly as v1
   * treated a dropped message POST, and reading any of it as the boundary is
   * what parked live runs under "Needs you" at exactly 5:00. The end comes
   * from the wire `session.idle` (2.x `session.execution.succeeded`, via the
   * translator), with `armTurnGrace()` as the bounded way out when no such
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
    const seq = ++this.turnSeq;
    this.turnInFlight = true;
    this.turnPostSettled = false;
    this.turnDropped = undefined;
    const turnEnded = new Promise<void>((resolve) => {
      this.endTurn = resolve;
    });
    // v2 turn boundary — the prompt POST is the turn start (§7.1).
    this.emitUi(opencodeTurnStarted);
    // Shared error handling for both requests below: a transport drop on a
    // session the event bus still shows alive is no evidence about the agent
    // — swallow it and keep listening. Anything else (an HTTP status, a dead
    // server) is a real failure. Once superseded, this turn is closed and its
    // late verdicts belong to nobody — the newer turn owns the flags.
    let failure: unknown;
    const record = (err: unknown): void => {
      if (seq !== this.turnSeq) return;
      if (this.isDropWhileSessionLives(err)) {
        this.turnDropped = err instanceof Error ? err.message : String(err);
      } else {
        failure = err;
      }
    };
    try {
      const res = await this.http('POST', `/api/session/${this.sessionId}/prompt`, { text });
      this.absorbUsage(res);
    } catch (err) {
      record(err);
    }
    if (failure === undefined) {
      // The long poll — v1's held-open message POST, renamed. It settles when
      // the loop is idle (or 204s at once if the turn already finished).
      try {
        await this.http('POST', `/api/experimental/session/${this.sessionId}/wait`, {});
      } catch (err) {
        record(err);
      }
    }
    if (seq === this.turnSeq) {
      this.turnPostSettled = true;
      if (failure !== undefined) {
        this.finishTurn();
        throw failure;
      }
      this.armTurnGrace();
    }
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
   * meaningful once the turn's HTTP wait has settled — before that the turn is
   * plainly still running. With no event bus to listen to there is nothing to
   * wait for, so the settled response stays the boundary, exactly as it was.
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

  /** Did the turn's HTTP wait drop on a session the event bus still shows
   *  alive? (Works for the prompt POST and the `wait` long poll alike.) */
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
    this.sseConnected = await openOpencodeEventStream(`${this.baseUrl}/api/event`, {
      signal: this.sse.signal,
      headers: this.authHeaders(),
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    // 2.x frames get reshaped into v1 events here — the ONE place the two
    // wire generations meet; v1 frames pass through byte-identical (see
    // `opencode-v2-events.ts` for why everything downstream stays v1).
    for (const evt of this.translator.translate(parsed)) {
      this.emitUi((state) => mapOpencodeEvent(evt, state));
      this.handleEvent(evt);
    }
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
    const cost = info.cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && (this.lastCost === undefined || cost > this.lastCost)) {
      this.emit({ type: 'cost', usd: cost - (this.lastCost ?? 0) });
      this.lastCost = cost;
    }
  }

  // ---- http ---------------------------------------------------------------

  /**
   * One call to the server. Goes through `opencode-http.ts` rather than the
   * global `fetch` so no undici `headersTimeout`/`bodyTimeout` default cuts the
   * `wait` long poll at 300 s (#897) — see that module's header for why.
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
    const res = await opencodeRequest(`${this.baseUrl}${path}`, {
      method,
      body,
      headers: this.authHeaders(),
    });
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

  /** Basic auth header for the server's password (2.x requires it on every
   *  call); `undefined` when the server printed no password. */
  private authHeaders(): Record<string, string> | undefined {
    if (this.password === undefined) return undefined;
    return { authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` };
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

/** What the server printed: its bound URL, and its password if it printed
 *  one (2.x does, right behind the URL). */
interface ServerInfo {
  url: string;
  password?: string;
}

/** 2.x wraps created resources as `{data:{id}}`; tolerate the bare v1 `{id}`
 *  shape too, so a stub that answers the old way still boots. */
function sessionIdFrom(created: Record<string, unknown>): string | undefined {
  const data = created.data;
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const id = stringField(data as Record<string, unknown>, 'id');
    if (id !== undefined) return id;
  }
  return stringField(created, 'id');
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
