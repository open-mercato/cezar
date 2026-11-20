import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAppServerRunner } from '../../src/core/codex-app-server-runner.ts';
import type { AgentSession } from '../../src/core/agent-runner.ts';
import { CodexAppServerRpc, spawnCodexAppServer, waitForCodexAppServerExit } from '../../src/core/codex-app-server-transport.ts';
import { readNdjson } from '../../src/core/ndjson.ts';

// Opt-in native regression: node --import tsx --test test/native/codex-instructions.test.ts
// Requires a local Codex CLI; all model traffic stays on an isolated loopback Responses stub.
const available = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5_000 }).status === 0;
type Message = { role?: string; content?: Array<{ text?: string }> };
type ModelRequest = { input?: Message[] };
const NATIVE = 'NATIVE_CONFIG_SENTINEL: preserve this user guidance.';
const policy = (revision: string) => `Global instructions: do not run the full test suite. ${revision}`;
const textOf = (message: Message) => (message.content ?? []).map((part) => part.text ?? '').join('\n');

test('native Codex preserves configured guidance and delivers current task instructions after resume/fork', { skip: !available, timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-native-instructions-'));
  const home = join(root, 'codex-home');
  await mkdir(home);
  const captured: ModelRequest[] = [];
  const sessions: AgentSession[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.endsWith('/responses')) {
      res.writeHead(404).end();
      return;
    }
    captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest);
    const id = `response_${captured.length}`;
    const item = { id: `message_${captured.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type: string, body: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
    event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'Done.' });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(join(home, 'config.toml'), [
    'model="instruction-probe"', 'model_provider="local_probe"', 'check_for_update_on_startup=false',
    `developer_instructions=${JSON.stringify(NATIVE)}`, '[analytics]', 'enabled=false',
    '[model_providers.local_probe]', 'name="Isolated instruction probe"',
    `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false',
  ].join('\n'));
  const env = { CODEX_HOME: home };

  async function turn(userPrompt: string, systemPrompt?: string, sessionId?: string) {
    const before = captured.length;
    const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 10_000 }).startSession({
      cwd: root, env, userPrompt, systemPrompt, enforceReadOnly: true,
      ...(sessionId ? { sessionId, resume: true } : {}),
    }, undefined, { autoEndAfterFirstTurn: true });
    sessions.push(session);
    const result = await session.result;
    assert.equal(captured.length, before + 1, 'expected exactly one isolated model request');
    const request = captured.at(-1);
    assert.ok(request);
    assert.ok(result.sessionId);
    return { request, sessionId: result.sessionId };
  }

  try {
    const first = await turn('First task turn', policy('FIRST_REVISION'));
    const resumed = await turn('Resumed task turn', policy('CURRENT_REVISION'), first.sessionId);
    // Fork a persisted thread, then enter it through the same runner used by Continue.
    const child = spawnCodexAppServer('codex', root, env);
    const rpc = new CodexAppServerRpc(child);
    child.once('exit', () => rpc.rejectPending());
    child.once('error', () => rpc.rejectPending());
    const reading = (async () => {
      for await (const line of readNdjson(child.stdout)) rpc.dispatchResponse(JSON.parse(line));
    })();
    child.stderr.resume();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
    let forkId: string;
    try {
      await rpc.initialize();
      const fork = await rpc.request('thread/fork', { threadId: resumed.sessionId, cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
      const thread = fork.thread as { id?: string } | undefined;
      assert.ok(thread?.id);
      forkId = thread.id;
    } finally {
      child.stdin.end();
      await waitForCodexAppServerExit(child);
      clearTimeout(deadline);
      await reading;
    }
    const forked = await turn('Forked task turn', policy('FORK_REVISION'), forkId);
    const cleared = await turn('Task turn without extra guidance', undefined, forked.sessionId);

    await t.test('native configuration survives every task session', () => {
      for (const { request } of [first, resumed, forked, cleared]) {
        assert.ok(request.input?.some((message) => message.role === 'developer' && textOf(message).includes(NATIVE)), 'native configured developer instructions must survive');
      }
    });
    for (const [name, { request }, expected] of [
      ['start', first, policy('FIRST_REVISION')],
      ['resume', resumed, policy('CURRENT_REVISION')],
      ['fork', forked, policy('FORK_REVISION')],
      ['cleared', cleared, undefined],
    ] as const) {
      await t.test(name, () => {
        const messages = request.input ?? [];
        const latest = messages.filter((message) => message.role === 'user').at(-1);
        assert.ok(latest);
        const text = textOf(latest);
        if (expected) assert.equal(text.split(expected).length - 1, 1, 'current task guidance must reach the model once');
        else assert.ok(!text.includes('REVISION'), 'cleared guidance must not be re-injected into the current turn');
        if (name !== 'start') assert.ok(!text.includes('FIRST_REVISION'), 'old guidance must not be re-injected into the current turn');
      });
    }
  } finally {
    for (const session of sessions) session.interrupt();
    await Promise.allSettled(sessions.map((session) => session.result));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
