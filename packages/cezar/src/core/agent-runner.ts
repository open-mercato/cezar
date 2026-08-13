/**
 * The backend-agnostic seam for running one agent task. Adapted from
 * @cezar/core's `agents/agent-runner.ts`, trimmed for single-user local use:
 * no token-budget circuit breaker, no zod response schemas — one run is one
 * agent-CLI session streaming normalized events.
 *
 * Four interchangeable backends implement this seam, each as a persistent
 * process so multi-turn follow-ups, `waiting`, interrupt and resume all work:
 *  - `claude`   — Claude Code CLI, stream-json over stdin/stdout;
 *  - `codex`    — `codex app-server`, JSON-RPC 2.0 (JSONL) over stdin/stdout;
 *  - `opencode` — `opencode serve`, HTTP + SSE;
 *  - `pi`       — pi coding CLI, RPC over JSONL stdin/stdout, selecting its
 *                 model with `provider/model`.
 */

import type { UiEvent } from './ui-events.ts';

/**
 * The user-selectable runners (what config/GUI expose), in display order — the SINGLE source of
 * truth for the set. Every runtime enumeration derives from this tuple (zod schemas, the
 * server-install "at least one agent CLI" gate, the CLI-handoff registry) rather than repeating
 * the literals, so adding runner #5 is a one-line change here and typecheck finds the rest.
 */
export const RUNNER_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;

/** The user-selectable runners (what config/GUI expose). */
export type RunnerId = (typeof RUNNER_IDS)[number];

/** `claude-cli` is the legacy id kept so old run records still parse. */
export type AgentBackend = RunnerId | 'claude-cli';

/** Narrow an arbitrary string (a config value, a check name) to a runner id. */
export function isRunnerId(value: string): value is RunnerId {
  return (RUNNER_IDS as readonly string[]).includes(value);
}

export interface AgentRunSpec {
  /** Appended to the CLI's default system prompt (`--append-system-prompt`). */
  systemPrompt?: string;
  userPrompt: string;
  /** Image blocks delivered with the first user message — screenshots pasted
   *  into the new-task form (spec 002's paste path, at task start). */
  images?: ContentBlock[];
  /** The directory the agent runs in — also the only writable root. */
  cwd: string;
  /** Tool allowlist; the CLI is default-deny for anything not listed — but
   *  the zero-config default (`DEFAULT_ALLOWED_TOOLS`) includes `Bash`
   *  unrestricted unless `bashAllowlist` is set, so treat the default as
   *  full shell access in `cwd`, not a sandboxed allowlist (#430). */
  allowedTools?: string[];
  /** When `Bash` is allowed, restrict it to commands starting with one of these. */
  bashAllowlist?: string[];
  /** Extra directories the agent may read/write besides `cwd`. */
  additionalDirectories?: string[];
  /** Extra env vars for the agent process (merged over `process.env`) —
   *  e.g. CEZ_HANDOFF_FILE / CEZ_TODOS_FILE / CEZ_TASK_ID (spec 007). */
  env?: Record<string, string>;
  model?: string;
  /** Wall-clock kill switch for the run (ms). */
  timeoutMs?: number;
  /**
   * Stable session id (UUID) so the user can take over interactively later:
   * `cd <repo> && claude --resume <sessionId>`.
   */
  sessionId?: string;
  /**
   * Spawn `claude --resume <sessionId>` instead of starting a fresh session —
   * picks up the on-disk conversation (used by "Continue" after a run ends).
   */
  resume?: boolean;
}

/**
 * Backends without a dedicated system-prompt channel (codex app-server,
 * opencode serve) deliver `spec.systemPrompt` as a leading block of the
 * opening user message — the documented per-backend mapping (spec §protocol
 * v2: claude = `--append-system-prompt`, codex/opencode = prepended here).
 */
export function prependSystemPrompt(systemPrompt: string | undefined, userPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
}

/**
 * True for the `128 + signal` exit codes an agent CLI reports when it handles
 * a stop signal itself instead of dying from it (SIGINT/SIGKILL/SIGTERM).
 *
 * Every runner arms a SIGTERM→SIGKILL watchdog on `end()` and signals on
 * `interrupt()` (#703): the CLIs install their own handlers, so a session the
 * runner tore down on purpose comes back as a NON-ZERO exit. Paired with a
 * "we sent the signal" flag, this predicate keeps that teardown out of the
 * error path — an exit cezar caused is never an agent failure.
 */
export function isSignalTerminationExit(exitCode: number | null): boolean {
  return exitCode === 130 || exitCode === 137 || exitCode === 143;
}

/** The slice of `ChildProcess` a termination tracker needs — keeps the helper
 *  usable from the transport layer and from test fakes alike. */
export interface TrackableChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * Returns a predicate that answers "has this child actually terminated?".
 *
 * `ChildProcess.killed` answers a different question — it flips as soon as a
 * signal is *delivered*, whether or not the child dies from it. Every agent CLI
 * installs its own SIGTERM handler, so gating a SIGTERM→SIGKILL watchdog on
 * `!child.killed` disables the escalation for exactly the child it exists for:
 * `killed` is true, `exitCode` stays null, and the process outlives the whole
 * grace window (#844, same defect fixed for the discovery probe in #841).
 *
 * Seeded from `exitCode`/`signalCode` so a child that died before the watchdog
 * was armed is recognized without waiting for an event that already fired.
 */
export function trackChildExit(child: TrackableChild): () => boolean {
  let exited = child.exitCode != null || child.signalCode != null;
  child.once('exit', () => {
    exited = true;
  });
  return () => exited;
}

/** One content block of a user message — mirrors the Anthropic wire format
 *  so it can be written to the claude CLI's stdin verbatim. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Normalized event stream — the GUI renders these, the store persists them. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  /** An image inside a tool result (screenshot tools, Read on a PNG…) —
   *  raw base64 here; the run manager persists it and re-emits a URL. */
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'cost'; usd: number }
  /** The backend's real session id, once known — codex threads and opencode
   *  sessions mint their own id, so the run manager persists this to enable
   *  resume ("Continue") and "open in CLI". Claude's equals `spec.sessionId`. */
  | { type: 'session'; sessionId: string }
  | { type: 'turn-end' }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentRunResult {
  /** Concatenated assistant text across the run, trimmed. */
  text: string;
  toolCalls: AgentToolCallRecord[];
  /** Cost-weighted token usage; 0 when the backend surfaced no telemetry. */
  tokensUsed: number;
  sessionId?: string;
}

export interface SessionOptions {
  /** Close the session shortly after the first turn ends (single-turn
   *  behavior, used for non-interactive workflow steps). Interactive
   *  sessions omit this and control `end()` themselves. */
  autoEndAfterFirstTurn?: boolean;
  /** Protocol-v2 channel: receives the normalized `UiEvent` stream emitted
   *  ALONGSIDE the v1 `AgentEvent`s (additive — v1 keeps flowing unchanged).
   *  RunManager consumption lands in R2 step 2.1. */
  onUiEvent?: (event: UiEvent) => void;
}

/**
 * A live agent session over one spawned backend process. The process stays
 * alive between turns and reads further user messages — that's what makes
 * mid-task follow-ups possible. Implemented identically by every backend
 * (claude stdin, codex app-server, opencode serve).
 */
export interface AgentSession {
  /** Resolves when the backend process exits — the session is fully over. */
  result: Promise<AgentRunResult>;
  /** OS pid of the spawned backend process — the root of the run's process
   *  tree (agents spawn Bash children under it). Absent when the spawn
   *  failed before a pid existed. Feeds live resource telemetry (#348). */
  readonly pid?: number;
  /** Write a user message into the live session. False when it is closed. */
  sendMessage(content: ContentBlock[]): boolean;
  /** Graceful close: end input, then a SIGTERM→SIGKILL watchdog. */
  end(): void;
  /** Hard stop (used by cancel). */
  interrupt(): void;
  /** True while the session still accepts messages. */
  readonly open: boolean;
}

export interface AgentRunner {
  readonly backend: AgentBackend;
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;
  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts?: SessionOptions,
  ): AgentSession;
  interrupt(): Promise<void>;
}
