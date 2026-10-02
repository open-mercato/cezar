/**
 * Agent Client Protocol (ACP) client — the transport shared by every ACP runner (spec
 * `2026-09-19-runner-seam-native-backends` § "The shared ACP layer"). Transport only: JSON-RPC 2.0
 * over NDJSON on a child's stdio, request-id bookkeeping and timeouts. It knows no vendor: which
 * binary speaks ACP, which flags start it and how its frames become `UiEvent`s all live in the
 * runner and its dialect.
 *
 * Wire schema: the ACP SDK (`PROTOCOL_VERSION = 1`, https://agentclientprotocol.com), as bundled in
 * `@google/gemini-cli` 0.60.0 and verified against it — see `__fixtures__/gemini/README.md`.
 *
 * Every frame in either direction is handed to `onFrame` BEFORE it takes effect (an inbound
 * response is tapped before its promise settles), so a mapper fed from that tap sees the wire in
 * wire order. That is the whole contract the golden fixtures replay.
 */
import { readNdjson } from './ndjson.ts';

/** One JSON-RPC 2.0 message, in either direction. Everything is optional: it came off a wire. */
export interface AcpMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export type AcpDirection = 'in' | 'out';

/** A JSON-RPC error answer, with the agent's own code and data kept for classification. */
export class AcpRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

/** The client's side of `initialize`: cezar proxies no file system and no terminal, so the agent
 *  uses its own tools inside the session's `cwd` (spec § "The shared ACP layer"). */
export const ACP_PROTOCOL_VERSION = 1;
export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

/** Answer to an inbound request: `result` on success, or a JSON-RPC `error`. */
export type AcpRequestAnswer = { result: unknown } | { error: { code: number; message: string } };

export interface AcpClientOptions {
  /** Every parsed frame, in wire order, before it takes effect. */
  onFrame?: (direction: AcpDirection, message: AcpMessage) => void;
  /** Inbound notifications (`session/update`, …). */
  onNotification?: (message: AcpMessage) => void;
  /**
   * Inbound requests (`session/request_permission`, …). The answer is written back under the
   * request's id. Without a handler — or when it throws — the agent gets `-32601`, so a request
   * cezar does not understand can never leave the agent waiting on an answer that never comes.
   */
  onRequest?: (message: AcpMessage) => AcpRequestAnswer | Promise<AcpRequestAnswer>;
  /** A stdout line that is not a JSON object. Skipped either way; this only reports it. */
  onUnparseable?: (line: string) => void;
}

interface Pending {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AcpClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closedReason: string | null = null;

  constructor(
    private readonly input: NodeJS.WritableStream & { destroyed?: boolean; writable?: boolean },
    private readonly output: NodeJS.ReadableStream,
    private readonly opts: AcpClientOptions = {},
  ) {}

  /**
   * The read loop. Resolves when the agent's stdout ends — the agent exited or closed it — and
   * rejects every request still waiting, because nothing can answer it any more. Never throws on
   * wire content: unparseable lines are skipped, unknown ids are ignored.
   */
  async run(): Promise<void> {
    try {
      for await (const line of readNdjson(this.output)) this.receive(line);
    } finally {
      this.close('ACP agent closed its output');
    }
  }

  /** True once the connection is gone; every later request rejects at once. */
  get closed(): boolean {
    return this.closedReason !== null;
  }

  /**
   * Send a request and wait for its answer. `timeoutMs` bounds handshake-style calls; a
   * `session/prompt` is a whole agent turn and is left unbounded here (the run's own deadline
   * owns it).
   */
  request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) return Promise.reject(new Error(this.closedReason));
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      if (options.timeoutMs && options.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`ACP ${method} timed out after ${Math.round(options.timeoutMs! / 1000)}s`));
        }, options.timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Reject everything still waiting, and refuse new requests. Idempotent. */
  close(reason: string): void {
    if (this.closedReason === null) this.closedReason = reason;
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // ---- the ACP methods cezar uses -------------------------------------------------------

  initialize(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request(
      'initialize',
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: ACP_CLIENT_CAPABILITIES },
      { timeoutMs },
    );
  }

  newSession(cwd: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request('session/new', { cwd, mcpServers: [] }, { timeoutMs });
  }

  loadSession(sessionId: string, cwd: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request('session/load', { sessionId, cwd, mcpServers: [] }, { timeoutMs });
  }

  prompt(sessionId: string, prompt: AcpContentBlock[]): Promise<Record<string, unknown>> {
    return this.request('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  setModel(sessionId: string, modelId: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request('session/set_model', { sessionId, modelId }, { timeoutMs });
  }

  setMode(sessionId: string, modeId: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request('session/set_mode', { sessionId, modeId }, { timeoutMs });
  }

  // ---- internals -------------------------------------------------------------------------

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.opts.onUnparseable?.(line);
      return;
    }
    if (!isRecord(message)) {
      this.opts.onUnparseable?.(line);
      return;
    }
    const frame = message as AcpMessage;
    this.opts.onFrame?.('in', frame);

    if (typeof frame.method === 'string') {
      if (frame.id !== undefined) void this.answer(frame);
      else this.opts.onNotification?.(frame);
      return;
    }
    if (typeof frame.id !== 'number') return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (frame.error !== undefined) entry.reject(rpcError(frame.error));
    else entry.resolve(isRecord(frame.result) ? frame.result : {});
  }

  private async answer(request: AcpMessage): Promise<void> {
    let answer: AcpRequestAnswer;
    try {
      answer = this.opts.onRequest
        ? await this.opts.onRequest(request)
        : { error: { code: -32601, message: `Method not found: ${request.method}` } };
    } catch (error) {
      answer = { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
    this.write({ jsonrpc: '2.0', id: request.id, ...answer });
  }

  private write(message: AcpMessage): void {
    this.opts.onFrame?.('out', message);
    if (this.input.destroyed || this.input.writable === false) return;
    try {
      this.input.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The read loop and the child's exit own settlement when stdin disappears.
    }
  }
}

/** An ACP prompt content block (the subset cezar sends: text and base64 images). */
export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function rpcError(error: unknown): AcpRpcError {
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
    const code = typeof error.code === 'number' ? error.code : undefined;
    // Gemini puts the useful part of an internal error in `data.details` (an unknown session id,
    // for one — `__fixtures__/gemini/session-controls.ndjson`).
    const details = isRecord(error.data) && typeof error.data.details === 'string' ? error.data.details : undefined;
    return new AcpRpcError(details ? `${message}: ${details}` : message, code, error.data);
  }
  return new AcpRpcError(typeof error === 'string' ? error : JSON.stringify(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
