import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import type { AgentEvent, AgentToolCallRecord } from './agent-runner.js';
import { costWeightedTokens, type RawUsage } from './structured-output.js';
import type { SpawnFn } from './claude-cli-runner.js';
import { DEFAULT_RUN_TIMEOUT_MS, KILL_GRACE_MS, DEFAULT_USD_PER_MILLION_TOKENS } from './claude-cli-runner.js';

/**
 * One long-lived `claude --input-format stream-json` child that the
 * workflow engine drives by sending phase-marker user messages on stdin
 * and reading per-phase `result` envelopes on stdout.
 *
 * Lifecycle:
 *   const session = new PersistentClaudeSession({...});
 *   await session.start();
 *   const r1 = await session.sendPhase('verify-in-repo', verifyPrompt);
 *   const r2 = await session.sendPhase('analyzer',       analyzePrompt);
 *   const r3 = await session.sendPhase('fixer',          fixerPrompt);
 *   const r4 = await session.sendPhase('reviewer',       reviewerPrompt);
 *   await session.stop();
 *
 * Token telemetry (Q5): cumulative usage is tracked across the session;
 * each `sendPhase` returns the *delta* used by that phase so the
 * workflow engine can write per-step `agent_runs.tokens_used`.
 *
 * Schema validation policy (Q6): NOT enforced here. `sendPhase` returns
 * the raw assistant text; the engine attempts a best-effort parse with
 * the phase schema and emits a `note` event on mismatch rather than
 * throwing.
 *
 * Backend lock (Q4): this class is unconditionally claude-cli; the
 * runner factory rejects `mode='unified'` with other backends before
 * we get here.
 */
export interface PersistentClaudeSessionOptions {
  systemPrompt: string;
  /** Stable id passed to `claude --session-id`; lets the operator
   *  `claude --resume <sessionId>` later. */
  sessionId: string;
  cwd: string;
  model?: string;
  allowedTools: string[];
  bashAllowlist?: string[];
  additionalDirectories?: string[];
  /** Hard wall-clock cap for the whole session before SIGTERM → SIGKILL. */
  timeoutMs?: number;
  /** Override `claude` binary (e.g. mock-claude.mjs for dry-run). */
  bin?: string;
  spawnFn?: SpawnFn;
  /** Subscribed to every assistant text / tool-call / token-usage event. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * When true, spawn `claude --resume <sessionId>` instead of
   * `--session-id <sessionId>` so the new child picks up the on-disk
   * conversation. Used by the workflow engine when a job is re-claimed
   * after a runner crash. If the resume fails (cross-host re-claim —
   * the session blob lives under `~/.claude/` on the original host),
   * the engine catches the failure and starts a fresh session under
   * the same id; see `claude-cli-runner.ts > isResumeFailure`.
   */
  resume?: boolean;
  /**
   * Idle timeout — if no `sendPhase` lands within this many ms, the
   * session closes itself cleanly. The next step that needs the session
   * re-opens with `--resume <sessionId>` (cheap on the same host;
   * gracefully falls back to a fresh start otherwise). Default 5 min;
   * set 0 to disable.
   */
  idleMs?: number;
}

/** Default idle session timeout (5 min). */
export const DEFAULT_IDLE_MS = 5 * 60_000;

export interface PhaseResult {
  /** Concatenated assistant text emitted during this phase. */
  text: string;
  /** Tool calls the agent made during this phase. */
  toolCalls: AgentToolCallRecord[];
  /** Cost-weighted tokens consumed by this phase (delta against
   *  cumulative session total at the start of the phase). */
  tokensUsed: number;
  /** Cumulative tokens used by the whole session as of this phase end. */
  cumulativeTokens: number;
}

export class PersistentClaudeSession {
  readonly sessionId: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  // Cumulative session totals.
  private cumulativeTokens = 0;
  private outBuffer = '';
  private resultResolver: ((r: PhaseResult) => void) | null = null;
  private resultRejecter: ((err: Error) => void) | null = null;
  // Per-phase accumulators reset every sendPhase.
  private phaseStartTokens = 0;
  private phaseText = '';
  private phaseToolCalls: AgentToolCallRecord[] = [];
  private sawTerminal = false;
  private timedOut = false;
  /** Resumed vs cold start — set at `start()` time, used to fall back
   *  to a fresh `--session-id` start if `--resume` errored out. */
  private resumed = false;
  /** Idle timer; reset on every `sendPhase`. Fires `closeIfIdle()`. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** True once `closeIfIdle()` has closed the child due to inactivity. */
  private closedIdle = false;

  constructor(private readonly opts: PersistentClaudeSessionOptions) {
    this.sessionId = opts.sessionId;
    // Honor CEZAR_DRY_RUN — keep parity with ClaudeCodeCliRunner.
    const defaultBin = process.env.CEZAR_DRY_RUN === '1' ? mockClaudePath() : 'claude';
    this.bin = opts.bin ?? defaultBin;
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  }

  /**
   * Spawn the long-lived child. Idempotent — calling twice is a no-op as long
   * as the child is alive (callers can use this to lazily re-open after
   * `closeIfIdle` without tracking lifecycle state). On spawn failure no
   * partial state is retained, so the caller can retry or fall back.
   */
  start(): void {
    if (this.child) return;
    // Reset all per-child state before spawning a fresh child. A prior child
    // (e.g. closed by `closeIfIdle`) may have left a partial NDJSON line in
    // `outBuffer` or a half-resolved phase; carrying that over into the new
    // child corrupts its first parse / trips the in-flight guard.
    this.outBuffer = '';
    this.sawTerminal = false;
    this.resultResolver = null;
    this.resultRejecter = null;
    this.closedIdle = false;
    this.resumed = this.opts.resume === true;
    const args = this.buildArgs();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.bin, args, { cwd: this.opts.cwd, env: process.env });
    } catch (err) {
      // Ensure no partial state leaks (no zombie child, no dangling timer):
      // start() is meant to be retryable.
      this.child = null;
      this.resumed = false;
      throw wrapSpawnError(err, this.bin);
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdoutChunk(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.opts.onEvent?.({ type: 'note', message: `claude stderr: ${truncate(chunk)}` });
    });
    child.on('error', (err: Error) => {
      this.resultRejecter?.(wrapSpawnError(err, this.bin));
    });
    // If `--resume` was rejected (e.g. cross-host re-claim — the on-disk
    // session blob lives under `~/.claude/` on the host that started it)
    // the child exits early with a non-zero code. Surface that as a
    // resume-failure so the caller can retry with a fresh `--session-id`
    // start under the same id.
    child.once('exit', (code) => {
      if (code != null && code !== 0 && this.resumed && !this.closedIdle) {
        this.resultRejecter?.(new ResumeFailedError(
          `claude --resume ${this.sessionId} exited with code ${code} — likely cross-host re-claim`,
        ));
      }
    });

    // Wall-clock kill switch covers the whole session, not per phase.
    const deadline = setTimeout(() => {
      this.timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }, this.timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
  }

  /**
   * Send a phase user message and wait for the next `type:'result'`
   * envelope. The returned `PhaseResult.tokensUsed` is the delta — i.e.
   * what this phase added on top of the session-cumulative total.
   *
   * If a sendPhase is in flight, subsequent calls reject. Phases must
   * be awaited serially.
   *
   * If the session was closed by `closeIfIdle()` (because the gap
   * between steps exceeded `idleMs`), this method re-opens it lazily
   * with `--resume <sessionId>` so the cumulative conversation prefix
   * stays intact. A cross-host re-open (or any other resume failure)
   * surfaces as a `ResumeFailedError` so the workflow engine can
   * retry without `resume`.
   */
  async sendPhase(phase: string, payload: string): Promise<PhaseResult> {
    if (this.timedOut) throw new Error('session timed out');
    if (this.resultResolver) throw new Error('phase in flight — await the prior sendPhase first');

    // Lazy re-open after `closeIfIdle` — same id, with resume so the
    // prior conversation prefix survives.
    if (!this.child && this.closedIdle) {
      this.opts.onEvent?.({ type: 'note', message: `claude session ${this.sessionId} reopening after idle close` });
      this.resumed = true;
      this.closedIdle = false;
      this.start();
    }

    if (!this.child) throw new Error('PersistentClaudeSession.start() not called');

    // Reset per-phase accumulators.
    this.phaseStartTokens = this.cumulativeTokens;
    this.phaseText = '';
    this.phaseToolCalls = [];
    this.sawTerminal = false;
    this.resetIdleTimer();

    const userMsg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `## PHASE: ${phase.toUpperCase()}\n\n${payload}` }] },
      session_id: this.sessionId,
    };

    return new Promise<PhaseResult>((resolve, reject) => {
      this.resultResolver = resolve;
      this.resultRejecter = reject;
      try {
        this.child!.stdin.write(`${JSON.stringify(userMsg)}\n`);
      } catch (err) {
        this.resultResolver = null;
        this.resultRejecter = null;
        reject(err as Error);
      }
    });
  }

  /**
   * Close the child if no `sendPhase` has been issued for `idleMs`.
   * Idempotent. The next `sendPhase` re-opens with `--resume` so
   * the conversation prefix is preserved.
   */
  closeIfIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.child || this.resultResolver) return;
    this.closedIdle = true;
    const child = this.child;
    this.child = null;
    try { child.stdin.end(); } catch { /* ignore */ }
    // Give the child a short grace period to exit on its own; SIGTERM
    // anything still hanging around.
    const grace = setTimeout(() => {
      if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
    }, 1_000);
    if (typeof grace.unref === 'function') grace.unref();
  }

  /** Close stdin and wait for the child to exit cleanly. */
  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    if (child.exitCode != null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('close', fin);
      child.once('exit', fin);
      // safety: don't hang forever if the child refuses to exit
      const safety = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM');
        const kill = setTimeout(() => {
          if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
          fin();
        }, KILL_GRACE_MS);
        if (typeof kill.unref === 'function') kill.unref();
      }, 5_000);
      if (typeof safety.unref === 'function') safety.unref();
    });
  }

  /** Cumulative cost-weighted tokens across the whole session. */
  get totalTokensUsed(): number {
    return this.cumulativeTokens;
  }

  // ─── internals ─────────────────────────────────────────────────────
  private buildArgs(): string[] {
    // Cross-restart resume (docs: Phase 2E). When `opts.resume` is set the
    // engine is asking us to pick up the on-disk conversation from the
    // previous host's run. Otherwise we mint a fresh session pinned to the
    // canonical id so a future re-claim can resume it.
    const sessionArg: string[] = this.resumed
      ? ['--resume', this.sessionId]
      : ['--session-id', this.sessionId];
    const args: string[] = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', this.opts.systemPrompt,
      '--permission-mode', 'acceptEdits',
      ...sessionArg,
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.allowedTools.length > 0) {
      args.push('--allowedTools', this.buildAllowedTools().join(','));
    }
    for (const dir of this.opts.additionalDirectories ?? []) {
      args.push('--add-dir', dir);
    }
    // Token budget cap (mirrors ClaudeCodeCliRunner's translation).
    // Per-phase enforcement is the workflow engine's job; the
    // session-wide cap is just a safety net.
    args.push('--max-budget-usd', String((DEFAULT_USD_PER_MILLION_TOKENS / 10).toFixed(2)));
    return args;
  }

  /**
   * Reset the idle-close timer. Called on every `sendPhase`. When the
   * timer fires we close the child (next `sendPhase` re-opens with
   * `--resume`). `idleMs=0` disables the timer entirely.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.closeIfIdle();
    }, this.idleMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  private buildAllowedTools(): string[] {
    const out: string[] = [];
    for (const tool of this.opts.allowedTools) {
      if (tool === 'Bash' && this.opts.bashAllowlist && this.opts.bashAllowlist.length > 0) {
        for (const prefix of this.opts.bashAllowlist) {
          const p = prefix.trim();
          if (p) out.push(`Bash(${p}:*)`);
        }
      } else {
        out.push(tool);
      }
    }
    return out;
  }

  private onStdoutChunk(chunk: string): void {
    this.outBuffer += chunk;
    let nl: number;
    while ((nl = this.outBuffer.indexOf('\n')) >= 0) {
      const line = this.outBuffer.slice(0, nl).trim();
      this.outBuffer = this.outBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as ClaudeStreamMessage;
        this.handleMessage(msg);
      } catch {
        this.opts.onEvent?.({ type: 'note', message: `claude: skipped unparseable line: ${truncate(line)}` });
      }
    }
  }

  private handleMessage(msg: ClaudeStreamMessage): void {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          this.phaseText += b.text;
          this.opts.onEvent?.({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use' && b.id && b.name) {
          this.phaseToolCalls.push({ id: b.id, name: b.name, input: b.input });
          this.opts.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
        }
      }
      const delta = costWeightedTokens(msg.message.usage);
      if (delta > 0) {
        this.cumulativeTokens += delta;
        this.opts.onEvent?.({ type: 'token-usage', tokensUsed: this.cumulativeTokens });
      }
      return;
    }

    if (msg.type === 'user' && msg.message?.content) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          this.opts.onEvent?.({
            type: 'tool-result',
            toolCallId: b.tool_use_id,
            result: stringifyContent(b.content),
            isError: b.is_error === true,
          });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      this.sawTerminal = true;
      const delta = costWeightedTokens(msg.usage);
      if (delta > 0) this.cumulativeTokens += delta;
      // The result `result` field carries the final assistant text;
      // only fall back to it if we never saw streamed assistant text.
      if (typeof msg.result === 'string' && this.phaseText.length === 0) {
        this.phaseText += msg.result;
        this.opts.onEvent?.({ type: 'text', text: msg.result });
      }
      const resolve = this.resultResolver;
      this.resultResolver = null;
      this.resultRejecter = null;
      // Restart the idle timer here so it counts the gap *until the next*
      // sendPhase, not the in-flight phase duration.
      this.resetIdleTimer();
      if (resolve) {
        resolve({
          text: this.phaseText,
          toolCalls: this.phaseToolCalls,
          tokensUsed: this.cumulativeTokens - this.phaseStartTokens,
          cumulativeTokens: this.cumulativeTokens,
        });
      }
      return;
    }

    // system/init and any other types — nothing actionable here.
  }
}

// ─── shared helpers (kept local so this file has no cross-runner deps) ──

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  message?: { role?: string; content?: unknown[]; usage?: RawUsage };
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      const b = c as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      try {
        return JSON.stringify(b);
      } catch {
        return String(b);
      }
    }).join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(`${bin} CLI not found on PATH — install claude or fall back to staged mode`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Thrown by `PersistentClaudeSession` when `claude --resume <id>` exits
 * non-zero (e.g. cross-host re-claim — the on-disk session blob lives under
 * `~/.claude/` on the host that originally created it). Caller catches it
 * and retries `start()` with `resume:false` so the runner spawns a fresh
 * session under the same id.
 */
export class ResumeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeFailedError';
  }
}

function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', 'scripts', 'mock-claude.mjs');
}
