/**
 * Claude Code permission prompts (`control_request` / `can_use_tool`) answered from the cockpit.
 * Spec `.ai/specs/2026-07-17-permission-modes.md` (Claude revision); precedent #2042.
 *
 * Pure: parsing a control frame, the ask card, the answer mapping and the response frames. The
 * runner owns the queue and the stdin writes. Wire shapes were checked against Claude Code
 * 2.1.332 and the Agent SDK's `canUseTool` bridge.
 */
import type { UiAskRequestedEvent } from './ui-events.ts';

/** Card ids of Claude permission prompts: `claude-permission-<control request_id>`. */
export const CLAUDE_PERMISSION_ASK_PREFIX = 'claude-permission-';

const ALLOW_ONCE = 'Allow once';
const ALWAYS_ALLOW = 'Always allow';
const REJECT = 'Reject';

const MAX_SUBJECT = 300;
const MAX_REASON = 300;
const MAX_NAME = 100;
const MAX_USER_WORDS = 500;

/** A `can_use_tool` request, narrowed to what the cockpit uses. */
export interface ClaudePermissionRequest {
  /** The control request's own id; the card id is `CLAUDE_PERMISSION_ASK_PREFIX + requestId`. */
  requestId: string;
  toolName: string;
  displayName?: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  decisionReason?: string;
  /** Claude's `addRules` allow suggestions, re-targeted to `destination: 'session'`; empty = no
   *  "Always allow" is offered. Never a `localSettings`/`projectSettings`/`userSettings` write. */
  alwaysRules: Record<string, unknown>[];
}

export type ClaudeControlMessage =
  | { kind: 'can-use-tool'; request: ClaudePermissionRequest }
  | { kind: 'cancel'; requestId: string }
  | { kind: 'unsupported'; requestId: string; subtype: string };

/** What the CLI's permission bridge accepts back (`PermissionResult`). */
export type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: Record<string, unknown>[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one stream-json frame as a control frame; undefined when it is not one cezar can answer. */
export function parseClaudeControlLine(msg: unknown): ClaudeControlMessage | undefined {
  if (!isRecord(msg)) return undefined;
  const requestId = msg.request_id;
  if (typeof requestId !== 'string' || requestId === '') return undefined;
  if (msg.type === 'control_cancel_request') return { kind: 'cancel', requestId };
  if (msg.type !== 'control_request') return undefined;
  const body = isRecord(msg.request) ? msg.request : {};
  const subtype = typeof body.subtype === 'string' ? body.subtype : 'unknown';
  if (subtype !== 'can_use_tool' || typeof body.tool_name !== 'string' || body.tool_name === '') {
    return { kind: 'unsupported', requestId, subtype };
  }
  return {
    kind: 'can-use-tool',
    request: {
      requestId,
      toolName: body.tool_name,
      ...(typeof body.display_name === 'string' && body.display_name !== '' ? { displayName: body.display_name } : {}),
      input: isRecord(body.input) ? body.input : {},
      ...(typeof body.tool_use_id === 'string' ? { toolUseId: body.tool_use_id } : {}),
      ...(typeof body.decision_reason === 'string' && body.decision_reason.trim() !== '' ? { decisionReason: body.decision_reason } : {}),
      alwaysRules: body.suppress_always_allow_rule === true ? [] : sessionRules(body.permission_suggestions),
    },
  };
}

/** Only `addRules` allow suggestions survive, and only for this session: Claude's own suggestions
 *  target `localSettings` (a `.claude/settings.local.json` write), and `setMode` / `addDirectories`
 *  would widen the run past the one call the user answered. */
function sessionRules(suggestions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.flatMap((s: unknown) =>
    isRecord(s) && s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)
      ? [{ ...s, destination: 'session' }]
      : [],
  );
}

/** ANSI escapes and control characters (newline and tab kept) out of text Claude or a tool controls. */
function sanitize(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** What the call touches, in one line: the command, the path, the URL, the pattern, else the input. */
function subject(request: ClaudePermissionRequest): string {
  const { input } = request;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return clip(sanitize(value), MAX_SUBJECT);
  }
  let json = '{}';
  try {
    json = JSON.stringify(input) ?? '{}';
  } catch {
    // an unserialisable input still gets a card
  }
  return clip(sanitize(json), MAX_SUBJECT);
}

/** The `ask.requested` card for one prompt — the same card OpenCode's permission prompts use. */
export function claudePermissionCard(request: ClaudePermissionRequest): UiAskRequestedEvent {
  const reason = request.decisionReason ? sanitize(request.decisionReason).trim() : '';
  const question = `Claude wants to use ${clip(sanitize(request.displayName ?? request.toolName), MAX_NAME)}: ${subject(request)}. Allow it?`;
  return {
    type: 'ask.requested',
    requestId: `${CLAUDE_PERMISSION_ASK_PREFIX}${request.requestId}`,
    questions: [{
      header: 'Permission',
      question: reason ? `${question}\n${clip(reason, MAX_REASON)}` : question,
      options: [
        { label: ALLOW_ONCE, description: 'Grant this one call.' },
        ...(request.alwaysRules.length > 0
          ? [{ label: ALWAYS_ALLOW, description: 'Grant it, and the same call, for the rest of this Claude session.' }]
          : []),
        { label: REJECT, description: 'Refuse it; Claude is told it was denied.' },
      ],
      multiSelect: false,
    }],
  };
}

/** The answer text from the card, minus the `Permission:` prefix the cockpit adds. */
function answerLabel(text: string): string {
  return text.trim().replace(/^Permission:\s*/i, '').trim().toLowerCase();
}

/** Map the user's raw answer to the CLI's `PermissionResult`; anything that is not an allow is a deny. */
export function claudePermissionAnswer(request: ClaudePermissionRequest, text: string): ClaudePermissionResult {
  const id = request.toolUseId !== undefined ? { toolUseID: request.toolUseId } : {};
  const label = answerLabel(text);
  if (label === ALLOW_ONCE.toLowerCase() || label === ALWAYS_ALLOW.toLowerCase()) {
    const always = label === ALWAYS_ALLOW.toLowerCase() && request.alwaysRules.length > 0;
    return {
      behavior: 'allow',
      updatedInput: request.input,
      ...(always ? { updatedPermissions: request.alwaysRules } : {}),
      ...id,
    };
  }
  if (label === REJECT.toLowerCase()) {
    return { behavior: 'deny', message: 'The user rejected this tool call in the cezar cockpit.', ...id };
  }
  const words = clip(sanitize(text.trim().replace(/^Permission:\s*/i, '')), MAX_USER_WORDS);
  return { behavior: 'deny', message: `The user did not approve this tool call in the cezar cockpit and replied: ${words}`, ...id };
}

/** The `control_response` line for a request cezar answered. */
export function claudeControlSuccess(requestId: string, result: ClaudePermissionResult): Record<string, unknown> {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: result } };
}

/** The `control_response` line for a request cezar cannot serve. */
export function claudeControlError(requestId: string, error: string): Record<string, unknown> {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}

/** Tools whose prompt is no permission at all: there is no cockpit bridge for them, so the model is
 *  told at once what to do instead. Today's `dontAsk` denies both too. */
export function claudeAutoDeny(request: ClaudePermissionRequest): ClaudePermissionResult | undefined {
  const id = request.toolUseId !== undefined ? { toolUseID: request.toolUseId } : {};
  if (request.toolName === 'AskUserQuestion') {
    return {
      behavior: 'deny',
      message: 'cezar cannot show AskUserQuestion. Ask the question in your reply instead, as a CEZ:ASK marker if you can, and wait for the answer.',
      ...id,
    };
  }
  if (request.toolName === 'ExitPlanMode') {
    return {
      behavior: 'deny',
      message: 'cezar cannot show ExitPlanMode. State the plan in your reply and proceed with the task, or ask what you need to know.',
      ...id,
    };
  }
  return undefined;
}

/** An autonomous or headless run: no human will answer, so the prompt is refused at once, not parked. */
export function claudeNobodyAnswersDeny(request: ClaudePermissionRequest): ClaudePermissionResult {
  return {
    behavior: 'deny',
    message: `cezar denied ${request.toolName} because nobody can answer permission prompts in this run. Do not retry it; report what was blocked and continue with what you can.`,
    ...(request.toolUseId !== undefined ? { toolUseID: request.toolUseId } : {}),
  };
}
