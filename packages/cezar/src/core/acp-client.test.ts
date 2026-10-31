import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { AcpClient, AcpRpcError, type AcpDirection, type AcpMessage } from './acp-client.ts';

/**
 * The shared ACP transport (spec 2026-09-19-runner-seam-native-backends, Phase 2 Step 2), driven
 * against a scripted NDJSON peer: `agentIn` is what the client writes (the agent's stdin),
 * `agentOut` is what the "agent" says back.
 */
function peer() {
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const frames: Array<[AcpDirection, AcpMessage]> = [];
  const received: AcpMessage[] = [];
  agentIn.setEncoding('utf8');
  let buffer = '';
  const waiters: Array<() => void> = [];
  agentIn.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      received.push(JSON.parse(buffer.slice(0, idx)) as AcpMessage);
      buffer = buffer.slice(idx + 1);
      waiters.splice(0).forEach((wake) => wake());
    }
  });
  const say = (value: unknown) => agentOut.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  const nextSent = async (count: number): Promise<AcpMessage[]> => {
    while (received.length < count) await new Promise<void>((wake) => waiters.push(wake));
    return received;
  };
  return { agentIn, agentOut, frames, received, say, nextSent };
}

describe('AcpClient', () => {
  it('correlates a request with its response and taps both frames in wire order', async () => {
    const p = peer();
    const client = new AcpClient(p.agentIn, p.agentOut, { onFrame: (d, m) => p.frames.push([d, m]) });
    const loop = client.run();
    const answer = client.initialize();
    const [sent] = await p.nextSent(1);
    expect(sent).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
    p.say({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await expect(answer).resolves.toEqual({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    expect(p.frames.map(([d, m]) => [d, m.id])).toEqual([
      ['out', 0],
      ['in', 0],
    ]);
    p.agentOut.end();
    await loop;
  });

  it('rejects a JSON-RPC error answer with the agent’s code and details', async () => {
    const p = peer();
    const client = new AcpClient(p.agentIn, p.agentOut);
    const loop = client.run();
    const answer = client.loadSession('nope', '/tmp');
    await p.nextSent(1);
    // Shape from __fixtures__/gemini/session-controls.ndjson (unknown session id).
    p.say({ jsonrpc: '2.0', id: 0, error: { code: -32603, message: 'Internal error', data: { details: 'Invalid session identifier "nope".' } } });
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcpRpcError);
    expect((error as AcpRpcError).code).toBe(-32603);
    expect((error as AcpRpcError).message).toBe('Internal error: Invalid session identifier "nope".');
    p.agentOut.end();
    await loop;
  });

  it('delivers notifications and answers inbound requests through the handler', async () => {
    const p = peer();
    const notes: AcpMessage[] = [];
    const client = new AcpClient(p.agentIn, p.agentOut, {
      onNotification: (m) => notes.push(m),
      onRequest: (m) =>
        m.method === 'session/request_permission'
          ? { result: { outcome: { outcome: 'selected', optionId: 'proceed_always' } } }
          : { error: { code: -32601, message: 'nope' } },
    });
    const loop = client.run();
    p.say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } } });
    p.say({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: { sessionId: 's', options: [] } });
    const sent = await p.nextSent(1);
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'proceed_always' } } });
    expect(notes).toHaveLength(1);
    p.agentOut.end();
    await loop;
  });

  it('answers an inbound request with -32601 when nothing handles it, and -32603 when the handler throws', async () => {
    const p = peer();
    const bare = new AcpClient(p.agentIn, p.agentOut);
    const loop = bare.run();
    p.say({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} });
    const [first] = await p.nextSent(1);
    expect(first).toMatchObject({ id: 7, error: { code: -32601 } });
    p.agentOut.end();
    await loop;

    const q = peer();
    const throwing = new AcpClient(q.agentIn, q.agentOut, {
      onRequest: () => {
        throw new Error('boom');
      },
    });
    const loop2 = throwing.run();
    q.say({ jsonrpc: '2.0', id: 'x', method: 'session/request_permission', params: {} });
    const [second] = await q.nextSent(1);
    expect(second).toEqual({ jsonrpc: '2.0', id: 'x', error: { code: -32603, message: 'boom' } });
    q.agentOut.end();
    await loop2;
  });

  it('skips malformed lines and frames with unknown ids without throwing', async () => {
    const p = peer();
    const skipped: string[] = [];
    const client = new AcpClient(p.agentIn, p.agentOut, { onUnparseable: (l) => skipped.push(l) });
    const loop = client.run();
    const answer = client.newSession('/repo');
    await p.nextSent(1);
    p.say('this is not json');
    p.say('[1,2,3]');
    p.say({ jsonrpc: '2.0', id: 99, result: { stray: true } });
    p.say({ jsonrpc: '2.0', id: 0, result: { sessionId: 'abc' } });
    await expect(answer).resolves.toEqual({ sessionId: 'abc' });
    expect(skipped).toEqual(['this is not json', '[1,2,3]']);
    p.agentOut.end();
    await loop;
  });

  it('rejects every pending request when the agent exits mid-request, and refuses new ones', async () => {
    const p = peer();
    const client = new AcpClient(p.agentIn, p.agentOut);
    const loop = client.run();
    const prompt = client.prompt('s', [{ type: 'text', text: 'hi' }]);
    await p.nextSent(1);
    p.agentOut.end(); // the child died: stdout closes with the prompt unanswered
    await loop;
    await expect(prompt).rejects.toThrow('ACP agent closed its output');
    expect(client.closed).toBe(true);
    await expect(client.newSession('/repo')).rejects.toThrow('ACP agent closed its output');
  });

  it('times out a bounded request and ignores its late answer', async () => {
    const p = peer();
    const client = new AcpClient(p.agentIn, p.agentOut);
    const loop = client.run();
    const init = client.initialize(20);
    await expect(init).rejects.toThrow('ACP initialize timed out');
    p.say({ jsonrpc: '2.0', id: 0, result: {} });
    p.agentOut.end();
    await loop;
  });

  it('sends session/cancel as a notification (no id)', async () => {
    const p = peer();
    const client = new AcpClient(p.agentIn, p.agentOut);
    const loop = client.run();
    client.cancel('s-1');
    const [sent] = await p.nextSent(1);
    expect(sent).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's-1' } });
    p.agentOut.end();
    await loop;
  });
});
