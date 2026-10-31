/**
 * GitHub Copilot CLI's ACP dialect (#582) — the per-runner mapper `AGENT_PROTOCOL.md` §9 step 4
 * asks for, over the shared `acp-ui-mapper.ts`.
 *
 * Every rule here was read off `@github/copilot` 1.0.88: the handshake and the auth error from a
 * live `copilot --acp` probe, the streaming frames from the CLI's own ACP bridge inside its
 * bundle. The verification record — with the commands and the code sites — is
 * `.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`, and `__fixtures__/copilot/`
 * cites it frame by frame.
 *
 * Three things make Copilot differ from the plain ACP reading:
 *  - it announces a **started** tool as `pending` and never sends `in_progress`;
 *  - it tags a delegated agent's tool calls with the delegating `task` call's id, which is real
 *    parent attribution — so the nesting cell of the parity matrix needs no substitute;
 *  - it carries **no tool name** on the wire, only a rendered title and an ACP kind.
 */
import {
  createAcpUiState,
  mapAcpFrame,
  type AcpDialect,
  type AcpUiMapperState,
  type AcpUiMapping,
} from './acp-ui-mapper.ts';
import type { ToolStatus } from './ui-events.ts';

/**
 * Copilot's own `_meta` namespace on `session/update` frames. Its only member is `agentId`, set
 * exactly when the tool call belongs to a delegated agent, and equal to the `toolCallId` of the
 * `task` call that spawned it.
 */
export const COPILOT_META_KEY = 'github.com/copilot';

/** What a user needs in order to run Copilot CLI. */
export const COPILOT_AUTH_HINT =
  'GitHub Copilot CLI needs a Copilot-entitled login — run `copilot login`, or export COPILOT_GITHUB_TOKEN (GH_TOKEN and GITHUB_TOKEN are also read, in that order).';

/** The run-time line for a rejected credential. "authentication failed" is what
 *  `isRuntimeProviderAuthFailure` keys on, so the server raises `provider-auth-required`. */
export const COPILOT_AUTH_FAILURE_MESSAGE =
  'Copilot CLI authentication failed — run `copilot login`, or set COPILOT_GITHUB_TOKEN (GH_TOKEN and GITHUB_TOKEN are read too, in that order).';

/**
 * Copilot answers an unauthenticated `session/new` with JSON-RPC `-32000 "Authentication
 * required"` (captured live; `newSession` throws `authRequired()` when the session has no
 * credential). The wording patterns cover the same failure arriving as prose on another frame.
 */
const AUTH_FAILURE_PATTERNS = [
  /authentication required/i,
  /not (?:logged in|authenticated)/i,
  /\bcopilot login\b/i,
  /no copilot (?:subscription|entitlement|access)/i,
] as const;

/** True for the Copilot auth failures cezar has seen on the wire (see the fixtures). */
export function isCopilotAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The tool's own name — a deliberate best-effort reconstruction.
 *
 * Copilot's ACP frames carry `title` (prose built by the CLI: "Editing src/app.ts") and the ACP
 * `kind`, but never the tool name, and its `_meta` holds only `agentId`. Rather than guess a name
 * from argument shapes that several tools share, only two are recovered — each keyed on an
 * argument the CLI's own code proves is that tool's — and everything else reports the ACP kind.
 * That costs nothing on screen: `upsertTool` prefers the wire `title` over anything derived from
 * the name, so the name is used for `toolKindOf` and as a coarse label.
 */
export function copilotToolName(update: Record<string, unknown>): string {
  const input = isRecord(update.rawInput) ? update.rawInput : undefined;
  // `skill` takes a single `skill` argument (the CLI titles it "Using skill: <skill>").
  if (input && typeof input.skill === 'string') return 'skill';
  // `task` is the delegation tool: ACP kind `other`, and the CLI's agent registry reads its
  // `arguments.name ?? arguments.description` as the subagent's display name.
  if (update.kind === 'other' && input && typeof input.description === 'string') return 'task';
  return typeof update.kind === 'string' && update.kind ? update.kind : 'tool';
}

/**
 * Copilot maps `task` to the ACP kind `other`, which would render a delegation as an ordinary
 * tool card. v2 has a real kind for it, and the parity matrix counts those items as sub-agents.
 */
function copilotToolKind(name: string): 'task' | undefined {
  return name === 'task' ? 'task' : undefined;
}

/**
 * Copilot emits `status: "pending"` from its own `tool.execution_start` and never sends
 * `in_progress`, so the ACP reading ("queued, not started") is the opposite of what happened.
 * A later status on the same call always wins, so a completed tool never falls back to running.
 */
function copilotToolStatus(update: Record<string, unknown>, previous: ToolStatus | undefined): ToolStatus | undefined {
  return update.status === 'pending' ? previous ?? 'running' : undefined;
}

/** The delegating `task` call's id, for a tool call a subagent made. */
export function copilotParentItem(update: Record<string, unknown>): string | undefined {
  const meta = isRecord(update._meta) ? update._meta : undefined;
  const own = meta && isRecord(meta[COPILOT_META_KEY]) ? (meta[COPILOT_META_KEY] as Record<string, unknown>) : undefined;
  return own && typeof own.agentId === 'string' && own.agentId ? own.agentId : undefined;
}

export const copilotDialect: AcpDialect = {
  backend: 'copilot',
  toolNameOf: copilotToolName,
  toolKindOf: copilotToolKind,
  toolStatusOf: copilotToolStatus,
  parentItemOf: copilotParentItem,
  // Per-turn counts need no dialect hook: Copilot answers `session/prompt` with a top-level
  // `usage` in exactly the ACP shape the shared mapper's `standardUsage` already reads
  // (`{inputTokens, outputTokens, totalTokens, thoughtTokens?, cachedReadTokens?,
  // cachedWriteTokens?}`). Its separate `usage_update` frame is a context-window gauge
  // (`{used, size}`), not token counts, and is not mapped — see the notes' § Token usage.
  errorMessage: (error) => {
    const text = `${typeof error.message === 'string' ? error.message : ''} ${JSON.stringify(error.data ?? '')}`;
    return isCopilotAuthFailure(text) ? COPILOT_AUTH_FAILURE_MESSAGE : undefined;
  },
};

export type CopilotUiMapperState = AcpUiMapperState;

export function createCopilotUiState(): CopilotUiMapperState {
  return createAcpUiState();
}

export function mapCopilotFrame(frame: unknown, state: CopilotUiMapperState): AcpUiMapping {
  return mapAcpFrame(frame, state, copilotDialect);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
