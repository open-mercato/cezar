/**
 * The MCP server under `cez mcp`, by hand (#1109): JSON-RPC 2.0 over stdio, one message per
 * line, the 2025 protocol era (`initialize` handshake). It serves tools and nothing else, which
 * is the whole of what an SDK would have carried here — so cezar keeps its dependency budget.
 *
 * Batches (JSON arrays) are refused with -32600: the 2025-06-18 revision dropped them and no
 * client sends one. Requests are answered in any order; a `notifications/cancelled` aborts the
 * call's signal and its answer is never sent, as the spec asks.
 */
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

/** Newest first; a client asking for another version gets the newest (spec: lifecycle). */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolContext {
  /** Aborted when the client cancels the call or the connection closes. */
  signal: AbortSignal;
  /** Present only when the client asked for progress (`_meta.progressToken`). */
  progress?: (progress: number, message?: string) => Promise<void>;
}

type AnyObject = z.ZodObject<z.ZodRawShape>;

export interface ToolConfig<I extends AnyObject> {
  title: string;
  description: string;
  inputSchema?: I;
  outputSchema: AnyObject;
  annotations: ToolAnnotations;
}

interface Tool {
  descriptor: Record<string, unknown>;
  input?: AnyObject;
  handler: (args: unknown, ctx: ToolContext) => Promise<CallToolResult>;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
}

type Message = Record<string, unknown>;
type Id = string | number;

const jsonSchema = (schema: AnyObject, io: 'input' | 'output') => z.toJSONSchema(schema, { io, unrepresentable: 'any' });

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class McpServer {
  private readonly tools = new Map<string, Tool>();

  constructor(
    readonly info: ServerInfo,
    readonly instructions: string,
  ) {}

  registerTool<I extends AnyObject = z.ZodObject<{}>>(
    name: string,
    config: ToolConfig<I>,
    handler: (args: z.output<I>, ctx: ToolContext) => Promise<CallToolResult>,
  ): void {
    this.tools.set(name, {
      descriptor: {
        name,
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema ? jsonSchema(config.inputSchema, 'input') : { type: 'object', properties: {} },
        outputSchema: jsonSchema(config.outputSchema, 'output'),
        annotations: config.annotations,
      },
      ...(config.inputSchema ? { input: config.inputSchema } : {}),
      handler: handler as Tool['handler'],
    });
  }

  /** One connection: feed it parsed-or-raw lines, it answers through `send`. */
  connect(send: (message: Message) => void): { receive: (line: string) => void; close: () => void } {
    const inFlight = new Map<Id, AbortController>();
    const reply = (id: Id, result: unknown) => send({ jsonrpc: '2.0', id, result });
    const error = (id: Id | null, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

    const request = async (id: Id, method: string, params: Message): Promise<unknown> => {
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: this.info, instructions: this.instructions };
        }
        case 'ping':
          return {};
        case 'tools/list':
          return { tools: [...this.tools.values()].map((t) => t.descriptor) };
        case 'tools/call':
          return this.call(id, params, inFlight, send);
        default:
          throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    };

    const receive = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return error(null, PARSE_ERROR, 'Parse error: not JSON');
      }
      if (Array.isArray(message)) return error(null, INVALID_REQUEST, 'Batches are not supported: send one message per line');
      if (!message || typeof message !== 'object') return error(null, INVALID_REQUEST, 'Invalid request: not an object');
      const m = message as Message;
      const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : undefined;
      if (m.jsonrpc !== '2.0' || (m.method !== undefined && typeof m.method !== 'string')) {
        return error(id ?? null, INVALID_REQUEST, 'Invalid request: not JSON-RPC 2.0');
      }
      const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Message;
      if (typeof m.method !== 'string') return; // a response: this server sends no requests
      if (m.id === undefined) {
        if (m.method === 'notifications/cancelled') inFlight.get(params.requestId as Id)?.abort(new Error(String(params.reason ?? 'cancelled')));
        return; // notifications/initialized and the rest need nothing
      }
      if (id === undefined) return error(null, INVALID_REQUEST, 'Invalid request: id must be a string or a number');
      void request(id, m.method, params).then(
        (result) => {
          // A cancelled call gets no answer (spec: cancellation).
          if (result !== CANCELLED) reply(id, result);
        },
        (failure: unknown) =>
          failure instanceof RpcError ? error(id, failure.code, failure.message) : error(id, INTERNAL_ERROR, (failure as Error).message ?? String(failure)),
      );
    };

    return { receive, close: () => inFlight.forEach((controller) => controller.abort(new Error('connection closed'))) };
  }

  private async call(id: Id, params: Message, inFlight: Map<Id, AbortController>, send: (message: Message) => void): Promise<unknown> {
    const name = params.name;
    if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name');
    const tool = this.tools.get(name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Tool ${name} not found`);
    const parsed = tool.input ? tool.input.safeParse(params.arguments ?? {}) : { success: true as const, data: {} };
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return { content: [{ type: 'text', text: `Input validation error: Invalid arguments for tool ${name}: ${issues}` }], isError: true } satisfies CallToolResult;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    const meta = params._meta as Message | undefined;
    const token = meta?.progressToken;
    const ctx: ToolContext = {
      signal: controller.signal,
      ...(typeof token === 'string' || typeof token === 'number'
        ? {
            progress: async (progress: number, message?: string) => {
              if (!controller.signal.aborted) {
                send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, ...(message ? { message } : {}) } });
              }
            },
          }
        : {}),
    };
    try {
      const result = await tool.handler(parsed.data, ctx).catch(
        (failure: unknown): CallToolResult => ({ content: [{ type: 'text', text: (failure as Error).message ?? String(failure) }], isError: true }),
      );
      return controller.signal.aborted ? CANCELLED : result;
    } finally {
      inFlight.delete(id);
    }
  }
}

const CANCELLED = Symbol('cancelled');

export interface StdioStreams {
  stdin: Readable;
  stdout: Writable;
  /** Called once the client has closed stdin. */
  onClose: () => void;
}

/** Newline-delimited JSON-RPC over a pair of streams. Returns a function that stops serving. */
export function serveStdio(server: McpServer, { stdin, stdout, onClose }: StdioStreams): () => void {
  const connection = server.connect((message) => {
    if (stdout.writable) stdout.write(`${JSON.stringify(message)}\n`);
  });
  let buffered = '';
  const onData = (chunk: Buffer | string) => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl).replace(/\r$/, '');
      buffered = buffered.slice(nl + 1);
      if (line.trim()) connection.receive(line);
    }
  };
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    stdin.off('data', onData);
    connection.close();
    onClose();
  };
  stdin.on('data', onData);
  stdin.once('end', stop);
  stdin.once('close', stop);
  return stop;
}
