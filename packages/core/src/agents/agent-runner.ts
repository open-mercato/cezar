import type { z } from 'zod';
import type { TokenBudget } from '../actions/autofix/token-budget.js';

/**
 * Which underlying agent executor a runner drives. `anthropic-api` is today's
 * `@anthropic-ai/claude-agent-sdk` path; the two `*-cli` backends shell out to
 * the team's locally-installed subscription CLIs.
 */
export type AgentBackend = 'anthropic-api' | 'claude-cli' | 'codex-cli';

/**
 * A single agent run request. Backend-agnostic: every field here can be honored
 * (best-effort for the CLIs) by all three runners.
 */
export interface AgentRunSpec<T = unknown> {
  /** Built-in step prompt; a bound skill body is appended to this upstream. */
  systemPrompt: string;
  userPrompt: string;
  /** The git worktree the agent runs in — also the only writable root. */
  cwd: string;
  /** Tool allowlist (step + binding). */
  allowedTools: string[];
  /** When `Bash` is allowed, restrict it to commands starting with one of these. */
  bashAllowlist?: string[];
  /** Extra directories the agent may read/write besides `cwd`. */
  additionalDirectories?: string[];
  /** Resolved via the binding chain (§3.5); omit to use the backend default. */
  model?: string;
  maxTurns?: number;
  /** Wall-clock kill switch for the run (ms). Overrides the runner default. */
  timeoutMs?: number;
  /** Best-effort circuit breaker. CLIs report usage less granularly. */
  tokenBudget?: TokenBudget;
  /** Structured-output contract owned by the step; runners extract+validate. */
  responseSchema?: z.ZodSchema<T>;
  /** Stable session id passed to the backend so an operator can
   *  `claude --resume <id>` later. Today only honored by
   *  `ClaudeCodeCliRunner`; the API/SDK backend ignores it. */
  sessionId?: string;
  /** When true and `sessionId` is set, the claude-cli runner spawns
   *  `claude --resume <sessionId>` instead of starting a fresh session
   *  with `--session-id <sessionId>`. Used by the workflow engine when
   *  a job is re-claimed after a runner crash to pick up where the
   *  previous host left off. The runner falls back to a fresh start
   *  with the same id if the on-disk session can't be found (e.g.
   *  cross-host re-claim — the session blob lives under `~/.claude/`
   *  on the original host). API/SDK backend ignores. */
  resume?: boolean;
}

/**
 * Normalized event stream. Every backend translates its native message format
 * into these so nothing downstream cares which agent ran.
 *
 * Generalizes the old `agent-session.ts` `AgentEvent`:
 *   `tool`          → `tool-call`     (+ stable `id`)
 *   `tool-result`   → `tool-result`   (`toolUseId` → `toolCallId`)
 *   `turn-end`      → `token-usage`
 *   `budget-exceeded` is now surfaced as a `note` (the runner returns
 *                     `budgetExceeded: true` for the structured signal)
 *   `done` / `error` are new lifecycle terminals the CLIs emit explicitly.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentRunResult<T = unknown> {
  /** Concatenated assistant text across the run, trimmed. */
  text: string;
  /** Validated structured output, or null when `responseSchema` was unset or nothing parsed. */
  parsed: T | null;
  toolCalls: AgentToolCallRecord[];
  /** Cost-weighted token usage; 0 when the backend surfaces no telemetry. */
  tokensUsed: number;
  /** True when a configured `tokenBudget` tripped (run was interrupted early). */
  budgetExceeded: boolean;
  /** The session id this run executed under, when the backend has one.
   *  For `claude-cli` it's the value passed in via `spec.sessionId` (echoed
   *  back so the engine doesn't have to remember it); for API/SDK backends
   *  this stays undefined. */
  sessionId?: string;
}

/**
 * The seam every agent backend implements. One `run()` call = one step
 * execution; `interrupt()` is a best-effort cooperative stop (used for the
 * token-budget circuit breaker and run cancellation).
 */
export interface AgentRunner {
  readonly backend: AgentBackend;
  run<T = unknown>(
    spec: AgentRunSpec<T>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult<T>>;
  interrupt(): Promise<void>;
}

export {
  parseStructured,
  costWeightedTokens,
  CACHE_READ_WEIGHT,
  CACHE_CREATION_WEIGHT,
} from './structured-output.js';
export type { RawUsage } from './structured-output.js';

/**
 * Restrict `Bash` invocations to commands that start with one of the allowed
 * prefixes (after whitespace normalization). Shared by the runners that get a
 * per-command hook (the SDK path) — the CLIs lean on `--allowedTools`/`-s`
 * instead and can use this only for post-hoc auditing.
 */
export function isBashCommandAllowed(cmd: string, allowlist: string[]): boolean {
  const normalized = cmd.replace(/\s+/g, ' ').trim();
  return allowlist.some((allowed) => {
    const a = allowed.trim();
    return normalized === a || normalized.startsWith(`${a} `);
  });
}

export function extractBashCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd.trim() : null;
}
