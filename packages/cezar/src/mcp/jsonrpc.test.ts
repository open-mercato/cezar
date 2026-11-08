import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connectStreams } from './client.testkit.ts';
import { McpServer, PROTOCOL_VERSIONS, serveStdio, type ToolContext } from './jsonrpc.ts';

/** The hand-rolled MCP transport under `cez mcp` (#1109): framing, the 2025 lifecycle, errors,
 *  cancellation and progress. The tools themselves are tested in `tools.test.ts`. */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function server() {
  const s = new McpServer({ name: 'cezar', title: 'Cezar', version: '1.2.3' }, 'Start with echo.');
  const seen: { signal?: AbortSignal; ctx?: ToolContext } = {};
  s.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Says it back.',
      inputSchema: z.object({ text: z.string().min(1).describe('What to say.'), times: z.number().int().optional() }),
      outputSchema: z.object({ text: z.string() }),
      annotations: READ,
    },
    async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: { text } }),
  );
  s.registerTool('bare', { title: 'Bare', description: 'No input.', outputSchema: z.object({}), annotations: READ }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: {},
  }));
  s.registerTool('boom', { title: 'Boom', description: 'Throws.', outputSchema: z.object({}), annotations: READ }, async () => {
    throw new Error('it broke');
  });
  s.registerTool('hang', { title: 'Hang', description: 'Waits for cancel.', outputSchema: z.object({}), annotations: READ }, async (_args, ctx) => {
    seen.ctx = ctx;
    await ctx.progress?.(1, 'started');
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { content: [{ type: 'text', text: 'late' }], structuredContent: {} };
  });
  return { s, seen };
}

/** The server on a pair of in-memory pipes, plus raw access to what it writes. */
function pipes() {
  const { s, seen } = server();
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  let raw = '';
  fromServer.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
    const parts = raw.split('\n');
    raw = parts.pop()!;
    for (const part of parts) lines.push(JSON.parse(part) as Record<string, unknown>);
  });
  let closed = 0;
  serveStdio(s, { stdin: toServer, stdout: fromServer, onClose: () => (closed += 1) });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { toServer, fromServer, lines, seen, settle, closed: () => closed };
}

describe('cez mcp transport: framing', () => {
  it('reads one message per line, however the bytes arrive', async () => {
    const p = pipes();
    const ping = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
    // two in one chunk, one split across three, a CRLF ending, blank lines in between
    p.toServer.write(`${ping(1)}\n${ping(2)}\n\n`);
    const third = ping(3);
    p.toServer.write(third.slice(0, 5));
    p.toServer.write(third.slice(5, 12));
    p.toServer.write(`${third.slice(12)}\r\n`);
    await p.settle();
    expect(p.lines).toEqual([1, 2, 3].map((id) => ({ jsonrpc: '2.0', id, result: {} })));
  });

  it('writes one JSON object per line and nothing else', async () => {
    const p = pipes();
    const out: string[] = [];
    p.fromServer.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    p.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    await p.settle();
    const text = out.join('');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('a line that is not JSON is a parse error, and the server keeps serving', async () => {
    const p = pipes();
    p.toServer.write('{not json\n');
    p.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
    await p.settle();
    expect(p.lines[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect(p.lines[1]).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it.each([
    ['a batch', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], null],
    ['a bare value', 42, null],
    ['no jsonrpc 2.0', { id: 3, method: 'ping' }, 3],
    ['an object id', { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, null],
  ])('%s is an invalid request', async (_, message, id) => {
    const p = pipes();
    p.toServer.write(`${JSON.stringify(message)}\n`);
    await p.settle();
    expect(p.lines).toEqual([{ jsonrpc: '2.0', id, error: { code: -32600, message: expect.any(String) } }]);
  });

  it('notifications and stray responses get no answer', async () => {
    const p = pipes();
    p.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    p.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever', params: {} })}\n`);
    p.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} })}\n`);
    await p.settle();
    expect(p.lines).toEqual([]);
  });

  it('closing stdin ends the session once, and aborts what is in flight', async () => {
    const p = pipes();
    p.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hang' } })}\n`);
    await p.settle();
    p.toServer.end();
    await p.settle();
    expect(p.closed()).toBe(1);
    expect(p.seen.ctx?.signal.aborted).toBe(true);
  });
});

describe('cez mcp transport: lifecycle and methods', () => {
  it('initialize answers serverInfo, instructions, the tools capability and the asked version', async () => {
    const p = pipes();
    const client = connectStreams(p.fromServer, p.toServer);
    const init = await client.initialize('2025-03-26');
    expect(init).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'cezar', title: 'Cezar', version: '1.2.3' },
      instructions: 'Start with echo.',
    });
  });

  it('a version it does not know is answered with its newest', async () => {
    const p = pipes();
    const client = connectStreams(p.fromServer, p.toServer);
    expect((await client.initialize('2099-01-01')).protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('an unknown method is -32601, a ping is {}', async () => {
    const p = pipes();
    const client = connectStreams(p.fromServer, p.toServer);
    await expect(client.request('resources/list')).rejects.toMatchObject({ code: -32601 });
    await expect(client.request('ping')).resolves.toEqual({});
  });

  it('tools/list carries title, annotations and JSON Schemas for input and output', async () => {
    const p = pipes();
    const client = connectStreams(p.fromServer, p.toServer);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === 'echo')!;
    expect(echo).toMatchObject({ title: 'Echo', description: 'Says it back.', annotations: READ });
    expect(echo.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, description: 'What to say.' }, times: { type: 'integer' } },
      required: ['text'],
    });
    expect(echo.outputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
    expect(tools.find((t) => t.name === 'bare')!.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('cez mcp transport: tools/call', () => {
  const setup = () => {
    const p = pipes();
    return { p, client: connectStreams(p.fromServer, p.toServer) };
  };

  it('answers content and structuredContent', async () => {
    const { client } = setup();
    expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      structuredContent: { text: 'hi' },
    });
    expect((await client.callTool({ name: 'bare' })).isError).toBeUndefined();
  });

  it('an unknown tool or a missing name is a protocol error (-32602)', async () => {
    const { client } = setup();
    await expect(client.callTool({ name: 'nope' })).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/Tool nope not found/) });
    await expect(client.request('tools/call', {})).rejects.toMatchObject({ code: -32602 });
  });

  it('bad arguments and a throwing tool are tool errors (isError), not protocol errors', async () => {
    const { client } = setup();
    const bad = await client.callTool({ name: 'echo', arguments: { text: '' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/^Input validation error: Invalid arguments for tool echo: text: /);
    expect(await client.callTool({ name: 'boom' })).toEqual({ content: [{ type: 'text', text: 'it broke' }], isError: true });
  });

  it('notifications/cancelled aborts the call, and its answer is never sent', async () => {
    const { p, client } = setup();
    const controller = new AbortController();
    const pending = client.callTool({ name: 'hang' }, { signal: controller.signal });
    await p.settle();
    expect(p.seen.ctx?.signal.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    await p.settle();
    expect(p.seen.ctx?.signal.aborted).toBe(true);
    // the tool returned "late" after the abort: nothing but the call's own progress went out
    expect(p.lines.filter((l) => 'result' in l || 'error' in l)).toEqual([]);
  });

  it('a cancel for an unknown or finished request is ignored', async () => {
    const { p, client } = setup();
    client.notify('notifications/cancelled', { requestId: 12345 });
    await p.settle();
    expect(await client.callTool({ name: 'echo', arguments: { text: 'still here' } })).toMatchObject({ structuredContent: { text: 'still here' } });
  });

  it('sends notifications/progress only when the client gave a progressToken', async () => {
    const { p, client } = setup();
    const progress: Array<{ progress: number; message?: string }> = [];
    const asked = new AbortController();
    void client.callTool({ name: 'hang' }, { signal: asked.signal, onprogress: (x) => progress.push(x) }).catch(() => {});
    await p.settle();
    expect(progress).toEqual([{ progress: 1, message: 'started' }]);
    asked.abort();

    const before = p.lines.length;
    const silent = new AbortController();
    void client.callTool({ name: 'hang' }, { signal: silent.signal }).catch(() => {});
    await p.settle();
    expect(p.seen.ctx?.progress).toBeUndefined();
    expect(p.lines.slice(before)).toEqual([]);
    silent.abort();
  });
});
