/**
 * Gemini CLI's ACP dialect (#581) — the per-runner mapper `AGENT_PROTOCOL.md` §9 step 4 asks for,
 * over the shared `acp-ui-mapper.ts`.
 *
 * Every rule here was read off the real wire of `gemini --acp` 0.60.0 (`docs/cli/acp-mode.md`),
 * captured in `__fixtures__/gemini/` — see that directory's README for the verification record.
 */
import {
  createAcpUiState,
  mapAcpFrame,
  type AcpDialect,
  type AcpUiMapperState,
  type AcpUiMapping,
} from './acp-ui-mapper.ts';
import type { TokenUsage } from './ui-events.ts';

/**
 * What an individual needs to run Gemini CLI today. Google retired "Sign in with Google" for Gemini
 * CLI on 2026-06-18 (google-gemini/gemini-cli#28229): a completed Google login fails every session
 * with `IneligibleTierError UNSUPPORTED_CLIENT` (`__fixtures__/gemini/unsupported-client.ndjson`).
 * cezar says this in its own words instead of relaying the vendor's migration pitch (spec U11).
 */
export const GEMINI_AUTH_HINT =
  'Gemini CLI needs an API key (aistudio.google.com), Vertex AI, or a Workspace/Code Assist license — personal Google sign-in no longer works for Gemini CLI.';

/** The run-time line for a rejected credential. "authentication failed" is what
 *  `isRuntimeProviderAuthFailure` keys on, so the server raises `provider-auth-required`. */
export const GEMINI_AUTH_FAILURE_MESSAGE = `Gemini CLI authentication failed — ${GEMINI_AUTH_HINT}`;

const AUTH_FAILURE_PATTERNS = [
  /UNSUPPORTED_CLIENT/,
  /IneligibleTier/i,
  /no longer supported for Gemini Code Assist/i,
  /API_KEY_INVALID/,
  /API key not valid/i,
  /authentication required/i,
] as const;

/** True for the Gemini auth failures cezar has seen on the wire or stderr (see the fixtures). */
export function isGeminiAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The tool's own name. Gemini's ACP frames carry a title and an ACP kind but no name and no
 * `rawInput`; the name survives only as the `toolCallId` prefix: `read_file__call_769873`,
 * `run_shell_command__call_703733`, `invoke_agent__call_620139`.
 */
export function geminiToolName(update: Record<string, unknown>): string {
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
  const match = /^(.+?)__call_/.exec(id) ?? /^(.+?)__/.exec(id);
  if (match?.[1]) return match[1];
  return typeof update.kind === 'string' ? update.kind : 'tool';
}

/** Per-turn counts from the `session/prompt` result's `_meta.quota.token_count`. */
function geminiUsage(result: Record<string, unknown>): TokenUsage | undefined {
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const quota = meta && isRecord(meta.quota) ? meta.quota : undefined;
  const count = quota && isRecord(quota.token_count) ? quota.token_count : undefined;
  if (!count) return undefined;
  const input = number(count.input_tokens) ?? 0;
  const output = number(count.output_tokens) ?? 0;
  const total = input + output;
  return total > 0 ? { input, output, total } : undefined;
}

export const geminiDialect: AcpDialect = {
  backend: 'gemini',
  toolNameOf: geminiToolName,
  // A subagent is the `invoke_agent` tool (ACP kind `think`, title "Delegating to agent '…'"). The
  // child's own work is not attributed on the wire, so this one `task` item IS the nesting cell's
  // documented substitute (spec § "Subagent nesting").
  toolKindOf: (name) => (name === 'invoke_agent' ? 'task' : undefined),
  usageFromPromptResult: geminiUsage,
  errorMessage: (error) => {
    const text = `${typeof error.message === 'string' ? error.message : ''} ${JSON.stringify(error.data ?? '')}`;
    return isGeminiAuthFailure(text) ? GEMINI_AUTH_FAILURE_MESSAGE : undefined;
  },
};

export type GeminiUiMapperState = AcpUiMapperState;

export function createGeminiUiState(): GeminiUiMapperState {
  return createAcpUiState();
}

export function mapGeminiFrame(frame: unknown, state: GeminiUiMapperState): AcpUiMapping {
  return mapAcpFrame(frame, state, geminiDialect);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
