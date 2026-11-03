/**
 * Pure junie ACP `session/update` → protocol-v2 mapper.
 *
 * Junie speaks the real Agent Client Protocol (`junie --acp=true`, verified
 * against `@jetbrains/junie` 26.9.22 with a live authenticated session — see
 * the wire captures cited inline below). ACP already uses cezar's own v2
 * vocabulary almost verbatim (`AGENT_PROTOCOL.md` §3: "ACP vocabulary
 * wherever a choice is arbitrary") — junie's `tool_call.kind` values
 * (`read`/`edit`/`execute`/`other`, confirmed live) map onto `ToolKind`
 * directly, and junie sends a ready-made human `title` on every tool call, so
 * this mapper needs no `toolDisplay()` guessing the other three backends
 * require.
 *
 * Confirmed live on the wire: `session_info_update`, `available_commands_update`,
 * `config_option_update` (all no-op for v2 — nothing to render), `agent_message_chunk`
 * (`content.type:'text'`, phases `commentary`/`final_answer` in `_meta.junie.phase`,
 * `_meta` itself sometimes absent — e.g. the "Task was interrupted" notice after a
 * `session/cancel`), `tool_call`/`tool_call_update` (`kind: other|edit|execute|read`,
 * `status: in_progress|completed|failed`, `content:[{type:'diff',path,newText}|
 * {type:'content',content:{type:'text',text}}]`, `rawInput:{command,cwd}`,
 * `rawOutput:{output,exitCode}`), and `usage_update` (cumulative context-window
 * usage + running session cost — NOT per-turn input/output, so it feeds only
 * `lastCostUsd` here; the authoritative per-turn `TokenUsage` comes from the
 * `session/prompt` RESPONSE, mapped by `junieUsageFromResponse` and fed into
 * `junieTurnCompleted` by the runner).
 *
 * NOT yet observed live — re-verified post-review (2026-09-27) by driving the
 * REAL ACP `session/set_config_option` knobs directly rather than only
 * choosing a stronger model: `configId: 'effort'` (`low|medium|high`,
 * confirmed live, `category: 'thought_level'`) set to `high`, `configId:
 * 'mode'` (`default|plan`) set to `plan`, and `model` set to
 * `v1:12:jetbrains-ai:claude-opus-5-5` (the strongest JetBrains-AI option
 * `session/new`'s `configOptions` advertised) — a multi-step planning prompt
 * under all three still produced only `agent_message_chunk` prose, no `plan`
 * and no `agent_thought_chunk`. Mapped per the public ACP schema
 * (agentclientprotocol.com) anyway, and exercised by
 * `__fixtures__/junie/schema-plan-reasoning.{ndjson,expected.json}`, a
 * SCHEMA-DERIVED fixture explicitly labelled as such rather than one claiming
 * a live capture that never happened (AGENT_PROTOCOL.md §7's "verify against
 * upstream wire shapes" rule, PR #443 precedent; ui-parity.test.ts's B2 review):
 *  - `agent_thought_chunk` (reasoning stream) — junie folded all visible
 *    reasoning into the final prose message for every model/effort tried,
 *    including the real `effort: 'high'` config option;
 *  - a structured `plan` update — junie's own "Plan mode" (now confirmed via
 *    the real `mode: 'plan'` config option, not just the `--plan` CLI flag)
 *    produces a prose planning document via `agent_message_chunk`, not a
 *    checklist, and a plain multi-step task never emitted one either.
 *
 * Genuinely unimplementable, not merely unobserved — no fixture, schema-derived
 * or otherwise, can cover these because the public ACP schema itself has no wire
 * shape to map: junie's `tool_call.kind` is unmodified core ACP
 * (`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`),
 * which has no `task` kind at all — cezar's `task` `ToolKind` is an extension
 * the OTHER three backends' bespoke sub-agent tool names map onto, not
 * something ACP itself defines. `_meta.jetbrains.air.capabilities` advertises
 * `nativeSubagentSessions`, but that capability has no published wire shape at
 * all (unlike `agent_thought_chunk`/`plan`, which at least have a schema this
 * mapper can implement ahead of observing them). ui-parity.test.ts's
 * "sub-agent task items" row and sub-agent nesting therefore exclude junie through
 * the documented path for a capability that "provably cannot exist on that backend's
 * own wire format" (`BACKWARD_COMPATIBILITY.md` §7): a cited, row-scoped `except` in
 * the `CAPABILITIES` table (`AGENT_PROTOCOL.md` §6), as cursor's rows do.
 *  - sub-agent nesting (`parentItemId`) — same reason: no wire shape exists, so
 *    no nesting is attempted; a spawned sub-agent (should one ever surface as
 *    a `tool_call`) renders as a flat, unnested item.
 *
 * Robustness rule (shared with every other mapper): input is untrusted wire
 * data, so this mapper never throws — malformed frames map to zero events.
 * State is explicit and immutable: callers thread the returned `state` into
 * the next call.
 */

import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  StopReason,
  TokenUsage,
  ToolKind,
  ToolLocation,
  ToolStatus,
  UiEvent,
  UiItem,
} from './ui-events.ts';

interface OpenMessage {
  kind: 'message' | 'reasoning';
  id: string;
  text: string;
  phase?: 'commentary' | 'final';
}

export interface JunieUiMapperState {
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  readonly openMessage: OpenMessage | null;
  readonly knownTools: ReadonlyMap<string, { title: string; name: string; input?: unknown; output?: string; diffs?: FileDiff[]; locations?: ToolLocation[]; exitCode?: number; error?: string }>;
  /** Last `usage_update.cost.amount` seen — cumulative-for-session, same
   *  semantics as claude's own `total_cost_usd` (also session-cumulative). */
  readonly lastCostUsd: number | null;
  /** Mints a fresh synthetic id for each NEW id-less message/reasoning item (see
   *  `mapMessageChunk`) — a shared per-kind constant folded unrelated id-less items together. */
  readonly noIdCounter: number;
}

export interface JunieUiMapping {
  events: UiEvent[];
  state: JunieUiMapperState;
}

export function createJunieUiState(): JunieUiMapperState {
  return {
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    openMessage: null,
    knownTools: new Map(),
    lastCostUsd: null,
    noIdCounter: 0,
  };
}

/** Junie's `session/new` RESULT carries the session id (no `session.started`
 *  notification exists on this wire) — the runner calls this once resolved. */
export function junieSessionStarted(sessionId: string, state: JunieUiMapperState): JunieUiMapping {
  if (state.sessionStarted || sessionId === '') return { events: [], state };
  return {
    events: [{ type: 'session.started', sessionId, backend: 'junie' }],
    state: { ...state, sessionStarted: true },
  };
}

/** Junie has no `turn/started` notification either — the runner calls this
 *  the moment it sends `session/prompt`. */
export function junieTurnStarted(state: JunieUiMapperState): JunieUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: { ...state, turnSeq, currentTurnId: turnId, openMessage: null, knownTools: new Map() },
  };
}

/**
 * `session/prompt`'s RESPONSE carries `stopReason` + per-turn `usage` — the
 * only point in the whole exchange with a real input/output/cache breakdown,
 * so the runner calls this once that response resolves (or the session ends
 * without one, e.g. a hard timeout) rather than folding it into the
 * notification switch below.
 */
export function junieTurnCompleted(
  stopReason: StopReason,
  usage: TokenUsage | undefined,
  state: JunieUiMapperState,
): JunieUiMapping {
  const closed = closeOpenMessage(state);
  const turnId = closed.state.currentTurnId ?? `turn_${closed.state.turnSeq || 1}`;
  const events: UiEvent[] = [...closed.events];
  const costUsd = closed.state.lastCostUsd ?? undefined;
  if (usage) events.push({ type: 'usage.updated', usage, ...(costUsd !== undefined ? { costUsd } : {}) });
  const completed: Extract<UiEvent, { type: 'turn.completed' }> = { type: 'turn.completed', turnId, stopReason };
  if (usage) completed.usage = usage;
  if (costUsd !== undefined) completed.costUsd = costUsd;
  events.push(completed);
  return { events, state: { ...closed.state, currentTurnId: null, knownTools: new Map() } };
}

/** `session/prompt`'s response `usage` (`inputTokens`/`outputTokens`/
 *  `totalTokens`/`cachedReadTokens`/`cachedWriteTokens`, confirmed live) → raw
 *  `TokenUsage`. Never pre-weighted. */
export function junieUsageFromResponse(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = nonNegative(raw.inputTokens);
  const output = nonNegative(raw.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const total = nonNegative(raw.totalTokens) ?? input + output;
  const usage: TokenUsage = { input, output, total };
  const cacheRead = nonNegative(raw.cachedReadTokens);
  const cacheWrite = nonNegative(raw.cachedWriteTokens);
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  return usage;
}

/** `session/prompt`'s response `stopReason` — `end_turn`/`cancelled` confirmed
 *  live; `refusal`/`max_turn_requests` (→`max_tokens`, the closest cezar word
 *  for "a resource limit ended the turn") are the documented ACP values not
 *  yet observed. Anything else degrades to `error` rather than guessing. */
export function junieStopReason(value: unknown): StopReason {
  if (value === 'end_turn' || value === 'cancelled' || value === 'refusal') return value;
  if (value === 'max_tokens' || value === 'max_turn_requests') return 'max_tokens';
  return 'error';
}

/** Fold one `session/update` notification's `params.update` payload into v2
 *  events. Never throws. */
export function mapJunieSessionUpdate(update: unknown, state: JunieUiMapperState): JunieUiMapping {
  if (!isRecord(update) || typeof update.sessionUpdate !== 'string') return { events: [], state };
  const kind = update.sessionUpdate;

  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    return mapMessageChunk(update, state, kind === 'agent_message_chunk' ? 'message' : 'reasoning');
  }

  // Anything else ends whatever message/reasoning item was streaming — junie
  // gives no explicit "message complete" signal, so the next non-chunk event
  // (a tool call, or the turn ending) is the boundary.
  const closed = closeOpenMessage(state);
  switch (kind) {
    case 'tool_call': {
      const mapped = mapToolCall(update, closed.state);
      return { events: [...closed.events, ...mapped.events], state: mapped.state };
    }
    case 'tool_call_update': {
      const mapped = mapToolCallUpdate(update, closed.state);
      return { events: [...closed.events, ...mapped.events], state: mapped.state };
    }
    // Not yet observed live (see module doc) — mapped per the public ACP
    // schema so a future junie version that emits it renders correctly.
    case 'plan': {
      const mapped = mapPlan(update, closed.state);
      return { events: [...closed.events, ...mapped.events], state: mapped.state };
    }
    case 'usage_update': {
      const cost = isRecord(update.cost) ? num(update.cost.amount) : undefined;
      return { events: closed.events, state: cost !== undefined ? { ...closed.state, lastCostUsd: cost } : closed.state };
    }
    default:
      // session_info_update, available_commands_update, config_option_update,
      // current_mode_update, user_message_chunk (the client already rendered
      // what it sent) — nothing to render in v2 yet.
      return closed;
  }
}

// ---- messages / reasoning ---------------------------------------------------

function closeOpenMessage(state: JunieUiMapperState): JunieUiMapping {
  const open = state.openMessage;
  if (!open) return { events: [], state };
  const item: UiItem =
    open.kind === 'message'
      ? { kind: 'message', id: open.id, role: 'assistant', text: open.text, ...(open.phase ? { phase: open.phase } : {}) }
      : { kind: 'reasoning', id: open.id, text: open.text };
  return { events: [{ type: 'item.completed', item }], state: { ...state, openMessage: null } };
}

function mapMessageChunk(
  raw: Record<string, unknown>,
  state: JunieUiMapperState,
  itemKind: 'message' | 'reasoning',
): JunieUiMapping {
  const text = contentTextOf(raw.content);
  if (text === undefined || text === '') return { events: [], state };
  // A frame without `messageId` still has real text to render (unlike a tool call with no id,
  // which `mapToolCall` correctly drops). Absent a wire id, a chunk that arrives while a
  // message/reasoning item of the SAME kind is already open continues that item (junie sends
  // no per-message id at all for some frames — e.g. the "Task was interrupted" notice — and no
  // separate continuation signal either, so this is the closest reading of intent). But a NEW
  // id-less item — nothing open, or a kind switch — must not collide with any other id-less
  // item: it gets a fresh id off `noIdCounter` rather than a shared per-kind constant, which
  // folded unrelated id-less messages together into one (#1111 review).
  const rawMessageId = str(raw.messageId);
  const openBefore = state.openMessage;
  const continuesOpenById =
    rawMessageId === undefined && openBefore !== null && openBefore.kind === itemKind;
  const mintsNoId = rawMessageId === undefined && !continuesOpenById;
  const noIdCounter = mintsNoId ? state.noIdCounter + 1 : state.noIdCounter;
  const messageId = rawMessageId ?? (continuesOpenById ? openBefore!.id : `junie-${itemKind}-no-id-${noIdCounter}`);
  state = { ...state, noIdCounter };

  const events: UiEvent[] = [];
  let open = state.openMessage;
  if (open && (open.id !== messageId || open.kind !== itemKind)) {
    const closed = closeOpenMessage(state);
    events.push(...closed.events);
    state = closed.state;
    open = null;
  }
  if (!open) {
    const item: UiItem =
      itemKind === 'message'
        ? { kind: 'message', id: messageId, role: 'assistant', text: '' }
        : { kind: 'reasoning', id: messageId, text: '' };
    events.push({ type: 'item.started', item });
    open = { kind: itemKind, id: messageId, text: '' };
  }
  events.push({
    type: 'item.delta',
    itemId: messageId,
    field: itemKind === 'message' ? 'text' : 'reasoning',
    delta: text,
  });
  const phase = phaseOf(raw._meta) ?? open.phase;
  return { events, state: { ...state, openMessage: { ...open, text: open.text + text, phase } } };
}

/** `_meta.junie.phase` (confirmed live: `commentary`|`final_answer`) —
 *  `_meta.codex.phase` is checked as a fallback since junie's own captures
 *  duplicated the same value under both keys; `_meta` is sometimes absent
 *  entirely (the post-cancel "Task was interrupted" notice carried none). */
function phaseOf(meta: unknown): 'commentary' | 'final' | undefined {
  if (!isRecord(meta)) return undefined;
  const junie = isRecord(meta.junie) ? meta.junie.phase : undefined;
  const codex = isRecord(meta.codex) ? meta.codex.phase : undefined;
  const phase = junie ?? codex;
  if (phase === 'commentary') return 'commentary';
  if (phase === 'final_answer') return 'final';
  return undefined;
}

function contentTextOf(content: unknown): string | undefined {
  if (!isRecord(content) || content.type !== 'text') return undefined;
  return typeof content.text === 'string' ? content.text : undefined;
}

// ---- tools -------------------------------------------------------------------

/** junie's `tool_call.kind` already speaks cezar's `ToolKind` vocabulary
 *  (confirmed live: `other`, `edit`, `execute`, `read`) — real ACP defines the
 *  same enum cezar's is a superset of, so any recognized value passes through
 *  verbatim and only a genuinely unknown one falls back to `other`. */
const KNOWN_TOOL_KINDS = new Set<ToolKind>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
]);

function toolKindOf(value: unknown): ToolKind {
  return typeof value === 'string' && (KNOWN_TOOL_KINDS as ReadonlySet<string>).has(value) ? (value as ToolKind) : 'other';
}

const STATUS_MAP: Readonly<Record<string, ToolStatus>> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
};

function toolStatus(value: unknown, fallback: ToolStatus): ToolStatus {
  return typeof value === 'string' ? (STATUS_MAP[value] ?? fallback) : fallback;
}

/** `content:[{type:'diff',path,oldText?,newText?,unified?}]` (confirmed live
 *  for file creation — no `oldText` key at all, which is `null`/"newly
 *  created" per `FileDiff`'s own contract) + `{type:'content',content:{type:
 *  'text',text}}` (confirmed live as the human-readable tool result). */
function toolContent(content: unknown): { output?: string; diffs?: FileDiff[]; locations?: ToolLocation[] } {
  if (!Array.isArray(content)) return {};
  const texts: string[] = [];
  const diffs: FileDiff[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type === 'diff' && typeof entry.path === 'string' && entry.path !== '') {
      const diff: FileDiff = {
        path: entry.path,
        oldText: typeof entry.oldText === 'string' ? entry.oldText : null,
      };
      if (typeof entry.newText === 'string') diff.newText = entry.newText;
      if (typeof entry.unified === 'string') diff.unified = entry.unified;
      diffs.push(diff);
    } else if (entry.type === 'content') {
      const text = contentTextOf(entry.content);
      if (text !== undefined) texts.push(text);
    }
  }
  const out: { output?: string; diffs?: FileDiff[]; locations?: ToolLocation[] } = {};
  if (texts.length > 0) out.output = texts.join('\n');
  if (diffs.length > 0) {
    out.diffs = diffs;
    out.locations = diffs.map((d) => ({ path: d.path }));
  }
  return out;
}

/** `locations:[{path,line?}]`, confirmed live for both edit and execute
 *  tool calls (execute carries an empty array). */
function toolLocations(value: unknown): ToolLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: ToolLocation[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.path === 'string' && entry.path !== '') {
      const location: ToolLocation = { path: entry.path };
      const line = num(entry.line);
      if (line !== undefined) location.line = line;
      locations.push(location);
    }
  }
  return locations.length > 0 ? locations : undefined;
}

/** `rawOutput:{output,exitCode}`, confirmed live on `execute` tool calls
 *  (both the failing `false` and the succeeding `echo done`). */
function rawOutputOf(value: unknown): { output?: string; exitCode?: number } {
  if (!isRecord(value)) return {};
  const out: { output?: string; exitCode?: number } = {};
  if (typeof value.output === 'string' && value.output !== '') out.output = value.output;
  const exitCode = num(value.exitCode);
  if (exitCode !== undefined) out.exitCode = exitCode;
  return out;
}

type KnownTool = NonNullable<ReturnType<JunieUiMapperState['knownTools']['get']>>;

function toolItemFrom(
  raw: Record<string, unknown>,
  id: string,
  status: ToolStatus,
  prior: KnownTool | undefined,
): { item: Extract<UiItem, { kind: 'tool' }>; snapshot: KnownTool } {
  const kind = toolKindOf(raw.kind);
  const title = str(raw.title) ?? prior?.title ?? 'Tool';
  const name = str(raw.kind) ?? prior?.name ?? 'other';
  const input = raw.rawInput !== undefined ? raw.rawInput : prior?.input;
  const fromContent = toolContent(raw.content);
  const fromRawOutput = rawOutputOf(raw.rawOutput);
  const output = fromContent.output ?? fromRawOutput.output ?? prior?.output;
  const diffs = fromContent.diffs ?? prior?.diffs;
  const locations = fromContent.locations ?? toolLocations(raw.locations) ?? prior?.locations;
  const exitCode = fromRawOutput.exitCode ?? prior?.exitCode;
  const error = status === 'failed' ? (fromContent.output ?? fromRawOutput.output ?? prior?.error) : undefined;

  const item: Extract<UiItem, { kind: 'tool' }> = { kind: 'tool', id, name, toolKind: kind, title, status };
  if (input !== undefined) item.input = input;
  if (output !== undefined) item.output = output;
  if (diffs !== undefined) item.diffs = diffs;
  if (locations !== undefined) item.locations = locations;
  if (exitCode !== undefined) item.exitCode = exitCode;
  if (error !== undefined) item.error = error;

  return { item, snapshot: { title, name, input, output, diffs, locations, exitCode, error } };
}

function mapToolCall(raw: Record<string, unknown>, state: JunieUiMapperState): JunieUiMapping {
  const id = str(raw.toolCallId);
  if (!id) return { events: [], state };
  const { item, snapshot } = toolItemFrom(raw, id, toolStatus(raw.status, 'running'), undefined);
  const knownTools = new Map(state.knownTools);
  knownTools.set(id, snapshot);
  return { events: [{ type: 'item.started', item }], state: { ...state, knownTools } };
}

function mapToolCallUpdate(raw: Record<string, unknown>, state: JunieUiMapperState): JunieUiMapping {
  const id = str(raw.toolCallId);
  if (!id) return { events: [], state };
  const prior = state.knownTools.get(id);
  const status = toolStatus(raw.status, 'running');
  const { item, snapshot } = toolItemFrom(raw, id, status, prior);
  const knownTools = new Map(state.knownTools);
  const terminal = status === 'completed' || status === 'failed' || status === 'declined';
  if (terminal) knownTools.delete(id);
  else knownTools.set(id, snapshot);
  return { events: [{ type: terminal ? 'item.completed' : 'item.updated', item }], state: { ...state, knownTools } };
}

// ---- plan (not yet observed live — see module doc) ---------------------------

function mapPlan(raw: Record<string, unknown>, state: JunieUiMapperState): JunieUiMapping {
  const list = Array.isArray(raw.entries) ? raw.entries : undefined;
  if (!list) return { events: [], state };
  const entries: PlanEntry[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const content = str(entry.content);
    if (content === undefined) continue;
    const planEntry: PlanEntry = { content, status: planStatus(entry.status) };
    if (entry.priority === 'high' || entry.priority === 'medium' || entry.priority === 'low') {
      planEntry.priority = entry.priority;
    }
    entries.push(planEntry);
  }
  if (list.length > 0 && entries.length === 0) return { events: [], state };
  return { events: [{ type: 'plan.updated', entries }], state };
}

function planStatus(value: unknown): PlanStatus {
  if (value === 'completed') return 'completed';
  if (value === 'in_progress') return 'in_progress';
  return 'pending';
}

// ---- tiny guards ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = num(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}
