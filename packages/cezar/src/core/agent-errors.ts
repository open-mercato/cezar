/** A backend refusing to run on the installed CLI — "OpenCode 1.18.0 or newer is required to use
 *  the free tier". The cockpit mirrors this pattern (`packages/web/src/lib/agent-errors.ts`) to
 *  offer the agent's update command next to the error. */
const OUTDATED_BACKEND_RE = /\b\d+\.\d+(?:\.\d+)?\+? or (?:newer|later|higher|above) is required\b|\brequires? (?:version |v)?\d+\.\d+(?:\.\d+)? or (?:newer|later|higher)\b/i;

export function isOutdatedBackendError(message: string): boolean {
  return OUTDATED_BACKEND_RE.test(message);
}

/** Above this the text is not a vendor's error line, and parsing it would only cost time. */
const MAX_ENVELOPE_INPUT = 8_192;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** `<type>: <message>` out of a parsed error envelope — Anthropic/OpenAI/Responses
 *  (`{ error: { type, message, code } }`, optionally `status`) and OpenCode (`{ name, data: { message } }`). */
function envelopeSummary(parsed: Record<string, unknown>, prefix: string): string | undefined {
  const inner = record(parsed.error);
  const data = record(parsed.data);
  // Only an error-shaped object: other JSON an error line quotes (a tool input) stays as it was.
  const bare = text(parsed.error);
  if (!inner && !bare && !(text(parsed.name) && text(data?.message))) return undefined;
  const message = text(inner?.message) ?? bare ?? text(data?.message);
  const kind = text(inner?.type) ?? text(inner?.code) ?? text(parsed.name);
  if (!message && !kind) return undefined;
  // The Responses envelope carries its status only inside the JSON (36b68a95); Claude's
  // `API Error: 400 [400]:` already said it.
  const status = typeof parsed.status === 'number' && !prefix.includes(String(parsed.status)) ? `${parsed.status} ` : '';
  const label = kind && kind !== 'error' ? kind : undefined;
  return `${status}${label && message ? `${label}: ${message}` : (message ?? label)}`;
}

/** A vendor error that embeds its JSON envelope — Codex forwards the Responses API's body as the
 *  turn error, Claude Code prints `API Error: 400 [400]: {…}` — rewritten as the error's own type
 *  and message, so the thread and telemetry show what the vendor said (spec 2026-10-24 item 9,
 *  generalizing #1576). Anything that is not such an envelope comes back unchanged. */
export function unwrapJsonErrorEnvelope(message: string): string {
  const start = message.indexOf('{');
  const end = message.lastIndexOf('}');
  if (start === -1 || end <= start || message.length > MAX_ENVELOPE_INPUT) return message;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(message.slice(start, end + 1)));
  } catch {
    return message;
  }
  const prefix = message.slice(0, start);
  const summary = parsed && envelopeSummary(parsed, prefix);
  return summary ? `${prefix}${summary}${message.slice(end + 1)}` : message;
}
