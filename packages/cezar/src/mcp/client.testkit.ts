/**
 * A minimal MCP client for tests — what the SDK's `Client` + `InMemoryTransport` did here.
 * Every message crosses as a serialized line, like on a real stdio pipe.
 */
import type { Readable, Writable } from 'node:stream';
import type { CallToolResult, McpServer } from './jsonrpc.ts';

type Message = Record<string, unknown>;

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: { type: string; properties?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
}

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`MCP error ${code}: ${message}`);
  }
}

export class TestClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly progress = new Map<number, (p: { progress: number; message?: string }) => void>();
  /** Every line the server sent that was not an answer to a request of ours. */
  readonly unsolicited: Message[] = [];
  protocolVersion?: string;

  constructor(
    readonly send: (line: string) => void,
    private readonly closer: () => void,
  ) {}

  receive(line: string): void {
    const message = JSON.parse(line) as Message;
    const id = message.id as number;
    const waiting = message.method === undefined ? this.pending.get(id) : undefined;
    if (waiting) {
      this.pending.delete(id);
      const error = message.error as { code: number; message: string } | undefined;
      if (error) waiting.reject(new RpcFailure(error.code, error.message));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === 'notifications/progress') {
      const params = message.params as { progressToken: number; progress: number; message?: string };
      this.progress.get(params.progressToken)?.({ progress: params.progress, ...(params.message ? { message: params.message } : {}) });
    }
    this.unsolicited.push(message);
  }

  request<T = unknown>(method: string, params?: Message, opts: { signal?: AbortSignal; id?: number } = {}): Promise<T> {
    const id = opts.id ?? this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      opts.signal?.addEventListener(
        'abort',
        () => {
          this.pending.delete(id);
          this.notify('notifications/cancelled', { requestId: id, reason: 'aborted by the test' });
          reject(new Error('aborted'));
        },
        { once: true },
      );
      this.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
    });
  }

  notify(method: string, params?: Message): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
  }

  async initialize(protocolVersion = '2025-06-18'): Promise<Message> {
    const result = await this.request<Message>('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.protocolVersion = result.protocolVersion as string;
    this.notify('notifications/initialized');
    return result;
  }

  listTools(): Promise<{ tools: ListedTool[] }> {
    return this.request('tools/list');
  }

  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    opts: { signal?: AbortSignal; onprogress?: (p: { progress: number; message?: string }) => void } = {},
  ): Promise<CallToolResult> {
    const id = this.nextId++;
    if (opts.onprogress) this.progress.set(id, opts.onprogress);
    const _meta = opts.onprogress ? { _meta: { progressToken: id } } : {};
    return this.request<CallToolResult>('tools/call', { ...params, ..._meta }, { id, ...(opts.signal ? { signal: opts.signal } : {}) }).finally(() =>
      this.progress.delete(id),
    );
  }

  async close(): Promise<void> {
    this.closer();
  }
}

/** A client wired straight to `server`, already initialized. */
export async function connect(server: McpServer): Promise<TestClient> {
  let client!: TestClient;
  const connection = server.connect((message) => client.receive(JSON.stringify(message)));
  client = new TestClient((line) => queueMicrotask(() => connection.receive(line)), connection.close);
  await client.initialize();
  return client;
}

/** A client over a stdio-shaped pair of streams (newline-delimited), not yet initialized. */
export function connectStreams(fromServer: Readable, toServer: Writable): TestClient {
  const client = new TestClient(
    (line) => toServer.write(`${line}\n`),
    () => toServer.end(),
  );
  let buffered = '';
  fromServer.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (line.trim()) client.receive(line);
    }
  });
  return client;
}
