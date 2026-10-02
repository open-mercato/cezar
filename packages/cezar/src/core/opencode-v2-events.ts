/**
 * opencode 2.x SSE-bus → v1 `{type, properties}` translator.
 *
 * opencode 2.x renamed and reshaped its wire protocol: events carry their
 * payload under `data` (`session.text.delta`, `session.tool.called`,
 * `session.execution.succeeded`, …) instead of v1's `properties`
 * (`message.part.updated`, `session.idle`, …). Everything downstream of the
 * SSE parse — the runner's v1 `handleEvent`/`handlePart` and the protocol-v2
 * UI mapper (`opencode-ui-mapper.ts`, 760 lines plus golden fixtures) — speaks
 * v1, and both are pinned by tests and NDJSON recordings that replay v1
 * transcripts byte-for-byte. So the reshape happens once, at this boundary:
 * `OpencodeSession.handleFrame` parses a frame, asks the translator for the
 * v1 events it corresponds to, and feeds those to both consumers unchanged.
 *
 * Wire shapes (captured from a live `opencode serve` v2.0.x, envelopes like
 * `{id, created, type, data}`):
 *   session.text.started/delta/ended   {sessionID, assistantMessageID, ordinal, delta|text}
 *   session.reasoning.*                same, for the reasoning field
 *   session.tool.input.started         {id, name}          — name only
 *   session.tool.input.ended           {id, text}          — input as JSON text
 *   session.tool.called                {id, input, executed}
 *   session.tool.progress              {id, metadata}
 *   session.tool.success               {id, content:[{type,text}], metadata}
 *   session.tool.failed                {id, error:{message}, content, metadata}
 *   session.usage.updated              {sessionID, cost, tokens} (session-cumulative)
 *   session.execution.succeeded|failed|interrupted {sessionID[, error]}
 *
 * The mapper/runner contracts the output must satisfy:
 *   - `message.updated {info:{id, role:'assistant'}}` precedes any part of
 *     that message (both consumers gate parts on the known role — v1 learned
 *     the role from `message.updated`, 2.x has no role event at all);
 *   - text parts carry the FULL accumulated text per update (consumers diff
 *     it into deltas) and `time.end: number` once finished (the completion
 *     signal the coalescer and the mapper both use);
 *   - tool parts need `state.input` at FIRST sight (the runner records the
 *     tool call from the first part it sees), so nothing is emitted until
 *     `session.tool.called` supplies the parsed input — the ~25 ms
 *     input.started→called window renders nothing rather than a call without
 *     arguments;
 *   - usage rides `message.updated` under one stable id per session: 2.x
 *     reports it cumulatively on `session.usage.updated` with no message id,
 *     and a single stable id keeps the mapper's per-message sum equal to the
 *     session total (per-step snapshots would double count);
 *   - `session.execution.succeeded` is 2.x's word for "turn over" — v1's
 *     `session.idle`, the runner's turn boundary (#897). `failed` becomes
 *     `session.error` + `session.idle` (the mapper closes the turn as
 *     'error'), `interrupted` just `session.idle`.
 *
 * v1 frames pass through untouched: a frame with `properties` (or a v1-only
 * type) is returned as-is, so the bundled mock server and every NDJSON
 * recording keep replaying exactly as before. The mapper's never-throws rule
 * holds downstream either way; this translator is equally defensive — unknown
 * events translate to zero events.
 */

/** A parsed bus event in the shape the runner's `handleEvent` and the UI
 *  mapper consume: v1's `{type, properties}`. */
export interface OpencodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

/** Types only v1 emits (2.x uses `session.execution.*` and friends), so their
 *  presence marks a v1 frame even without a `properties` bag. */
const V1_ONLY_TYPES = new Set(['session.idle', 'session.error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Stateful: buffers, role announcements, and tool records live for the
 *  session — one instance per `OpencodeSession`, like the mapper state. */
export class OpencodeV2Translator {
  /** assistantMessageIDs whose `message.updated` (role) was announced. */
  private readonly announced = new Set<string>();
  /** Part key → accumulated text/reasoning so far. */
  private readonly buffers = new Map<string, string>();
  /** Part key → `time.start` (from the `.started` event's timestamp). */
  private readonly partStart = new Map<string, number>();
  /** Tool call id → tool name (known at input.started, input at called). */
  private readonly toolNames = new Map<string, string>();
  /** Tool call id → parsed input (from `tool.called`, or `input.ended`). */
  private readonly toolInputs = new Map<string, unknown>();
  /** Stable id under which cumulative session usage is reported. */
  private usageId: string | undefined;

  /** Translate one parsed SSE frame into zero or more v1 events. */
  translate(evt: unknown): OpencodeEvent[] {
    if (!isRecord(evt) || typeof evt.type !== 'string') return [];
    // v1 frame (mock server, NDJSON recordings) → passthrough, byte-identical.
    if ('properties' in evt || evt.type.startsWith('message.') || V1_ONLY_TYPES.has(evt.type)) {
      return [evt as OpencodeEvent];
    }

    const data = isRecord(evt.data) ? evt.data : {};
    const created = num(evt.created);
    const out: OpencodeEvent[] = [];

    // Role announcement: 2.x has no role event, but every assistant-side
    // event carries `assistantMessageID` — announce it on first sight, ahead
    // of any part in this same batch, so both consumers' role gates pass.
    const mid = str(data.assistantMessageID);
    if (mid !== undefined && !this.announced.has(mid)) {
      this.announced.add(mid);
      const info: Record<string, unknown> = { id: mid, role: 'assistant' };
      const sid = str(data.sessionID);
      if (sid !== undefined) info.sessionID = sid;
      if (created !== undefined) info.time = { created };
      out.push({ type: 'message.updated', properties: { info } });
    }

    const kind = evt.type.startsWith('session.reasoning.') ? 'reasoning' : 'text';
    switch (evt.type) {
      case 'session.text.started':
      case 'session.reasoning.started': {
        const key = partKey(data);
        this.buffers.set(key, '');
        if (created !== undefined) this.partStart.set(key, created);
        out.push(partEvent(data, key, kind, '', undefined));
        break;
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const key = partKey(data);
        const full = (this.buffers.get(key) ?? '') + (str(data.delta) ?? '');
        this.buffers.set(key, full);
        out.push(partEvent(data, key, kind, full, undefined));
        break;
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const key = partKey(data);
        // `.ended` carries the authoritative full text — use it even when
        // deltas were missed; fall back to what we accumulated.
        const full = str(data.text) ?? this.buffers.get(key) ?? '';
        this.buffers.set(key, full);
        const time: Record<string, number> = {};
        const start = this.partStart.get(key);
        if (start !== undefined) time.start = start;
        time.end = created ?? Date.now();
        out.push(partEvent(data, key, kind, full, time));
        break;
      }
      case 'session.tool.input.started': {
        const callID = str(data.id);
        if (callID !== undefined) {
          this.toolNames.set(callID, str(data.name) ?? 'tool');
          if (created !== undefined) this.partStart.set(callID, created);
        }
        // No emission: without input the runner's first sight would record
        // the tool call with the wrong payload (§ runner `handlePart`).
        break;
      }
      case 'session.tool.input.ended': {
        const callID = str(data.id);
        const text = str(data.text);
        if (callID !== undefined && text !== undefined && !this.toolInputs.has(callID)) {
          try {
            this.toolInputs.set(callID, JSON.parse(text));
          } catch {
            // Not JSON (free-form text input) — keep the raw string.
            this.toolInputs.set(callID, text);
          }
        }
        break;
      }
      case 'session.tool.called': {
        const callID = str(data.id);
        if (callID === undefined) break;
        if ('input' in data) this.toolInputs.set(callID, data.input);
        out.push(this.toolEvent(data, callID, 'pending', created, undefined));
        break;
      }
      case 'session.tool.progress': {
        const callID = str(data.id);
        if (callID === undefined) break;
        out.push(this.toolEvent(data, callID, 'running', created, undefined));
        break;
      }
      case 'session.tool.success': {
        const callID = str(data.id);
        if (callID === undefined) break;
        out.push(this.toolEvent(data, callID, 'completed', created, outputText(data.content)));
        break;
      }
      case 'session.tool.failed': {
        // 2.x's word for a tool that errored (`session.tool.error` does not
        // exist in the protocol — 0 occurrences in a v2.0.22 build). Payload:
        // `{id, assistantMessageID, error:{message}, content, metadata,
        // executed, resultState}`. The mapper reads `errorText(state.error)`,
        // so the message must land there or a failed tool renders as a tool
        // that never finished.
        const callID = str(data.id);
        if (callID === undefined) break;
        const message = errorOf(data.error) ?? str(data.error) ?? outputText(data.content) ?? 'tool failed';
        out.push(this.toolEvent(data, callID, 'error', created, message));
        break;
      }
      case 'session.usage.updated': {
        // Cumulative session totals, no message id — report them under ONE
        // stable id so the mapper's per-message sum stays the session total
        // (the runner takes the monotonic max either way).
        const sid = str(data.sessionID);
        this.usageId ??= `${sid ?? 'session'}#usage`;
        const info: Record<string, unknown> = { id: this.usageId, role: 'assistant' };
        if (sid !== undefined) info.sessionID = sid;
        if (isRecord(data.tokens)) info.tokens = data.tokens;
        if (num(data.cost) !== undefined) info.cost = data.cost;
        out.push({ type: 'message.updated', properties: { info } });
        break;
      }
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        out.push(idleEvent(data));
        break;
      case 'session.execution.failed': {
        // Non-fatal `session.error` (the mapper turns the red banner and
        // closes the turn as 'error'), then the boundary itself.
        const props: Record<string, unknown> = {};
        const sid = str(data.sessionID);
        if (sid !== undefined) props.sessionID = sid;
        if ('error' in data) props.error = data.error;
        out.push({ type: 'session.error', properties: props }, idleEvent(data));
        break;
      }
      default:
        // session.created, session.step.*, session.inbox.*, session.execution.started,
        // *.updated, server.connected (data form), heartbeats — nothing v1 wants.
        break;
    }
    return out;
  }

  /** One tool part update. Name comes from `input.started`, input from
   *  `called` (or the JSON text of `input.ended`) — both are remembered
   *  because a part emitted later still has to carry the call's arguments. */
  private toolEvent(
    data: Record<string, unknown>,
    callID: string,
    status: 'pending' | 'running' | 'completed' | 'error',
    created: number | undefined,
    output: string | undefined,
  ): OpencodeEvent {
    const state: Record<string, unknown> = { status };
    const input = this.toolInputs.get(callID);
    if (input !== undefined) state.input = input;
    if (output !== undefined) state.output = output;
    if (isRecord(data.metadata)) state.metadata = data.metadata;
    if (status === 'error') state.error = output; // mapper reads errorText(state.error)
    const time: Record<string, number> = {};
    const start = this.partStart.get(callID);
    if (start !== undefined) time.start = start;
    if (created !== undefined && (status === 'completed' || status === 'error')) time.end = created;
    if (Object.keys(time).length > 0) state.time = time;

    const part: Record<string, unknown> = {
      id: callID,
      callID,
      type: 'tool',
      tool: this.toolNames.get(callID) ?? 'tool',
      state,
    };
    const mid = str(data.assistantMessageID);
    if (mid !== undefined) part.messageID = mid;
    const sid = str(data.sessionID);
    if (sid !== undefined) part.sessionID = sid;
    return { type: 'message.part.updated', properties: { part } };
  }
}

// ---- helpers --------------------------------------------------------------

/** Deterministic part id: the message's own id plus the part ordinal — stable
 *  across started/delta/ended (the consumers key all their state on it). */
function partKey(data: Record<string, unknown>): string {
  const mid = str(data.assistantMessageID) ?? str(data.sessionID) ?? 'session';
  return `${mid}#${num(data.ordinal) ?? 0}`;
}

function partEvent(
  data: Record<string, unknown>,
  id: string,
  type: 'text' | 'reasoning',
  text: string,
  time: Record<string, number> | undefined,
): OpencodeEvent {
  const part: Record<string, unknown> = { id, type, text };
  const mid = str(data.assistantMessageID);
  if (mid !== undefined) part.messageID = mid;
  const sid = str(data.sessionID);
  if (sid !== undefined) part.sessionID = sid;
  if (time !== undefined) part.time = time;
  return { type: 'message.part.updated', properties: { part } };
}

function idleEvent(data: Record<string, unknown>): OpencodeEvent {
  const props: Record<string, unknown> = {};
  const sid = str(data.sessionID);
  if (sid !== undefined) props.sessionID = sid;
  return { type: 'session.idle', properties: props };
}

function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : safeStringify(content);
  const texts = content
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
  if (texts.length > 0) return texts.join('\n');
  return content.length > 0 ? safeStringify(content) : '';
}

function errorOf(error: unknown): string | undefined {
  if (isRecord(error)) return str(error.message) ?? str(error.name);
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
