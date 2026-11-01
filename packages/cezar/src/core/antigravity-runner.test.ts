import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { AntigravityRunner, antigravityUserFrame, buildAntigravityArgs } from './antigravity-runner.ts';
import { createRunner } from './runner-factory.ts';
import { buildChildEnv } from './agent-env.ts';
import { parseAntigravityModelsOutput } from './antigravity-model-catalog.ts';
import { isRuntimeProviderAuthFailure } from './provider-auth.ts';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function script(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-agy-test-'));
  dirs.push(dir);
  const bin = join(dir, 'fake.mjs');
  await writeFile(bin, source);
  return bin;
}

/** A fake `agy` speaking the live 1.4.0 stdin protocol: one turn per stdin frame, exit on EOF.
 *  `reply(content, argv)` is JS source returning the turn's text. */
const echoAgy = (reply = 'content') => `
import { createInterface } from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ event: 'init', conversation_id: 'conv-1', init: { cwd: process.cwd() } });
let i = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const content = JSON.parse(line).message.content;
  const argv = process.argv.slice(2);
  const text = (${reply});
  out({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: i++, state: 'DONE', step_type: 'user_input' } });
  const s = i++;
  out({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: s, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } });
  out({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: s, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } });
  out({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: text } });
}
`;

describe('Antigravity runner', () => {
  it('registers the native runner seam and keeps unrelated credentials out', () => {
    expect(createRunner('antigravity')).toBeInstanceOf(AntigravityRunner);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/test-bus');
    vi.stubEnv('GOOGLE_API_KEY', 'unrelated');
    const env = buildChildEnv({ backend: 'antigravity' });
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/test-bus');
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });

  it('keeps the prompt off the command line and ends argv with an empty -p=', () => {
    const args = buildAntigravityArgs({
      cwd: '/tmp',
      userPrompt: 'a "quoted" $(prompt)',
      systemPrompt: 'instructions',
      model: 'custom-model',
      resume: true,
      sessionId: 'conversation',
      additionalDirectories: ['/a b'],
    });
    expect(args).toEqual([
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions',
      '--model', 'custom-model', '--conversation', 'conversation', '--add-dir', '/a b', '-p=',
    ]);
    expect(args.join(' ')).not.toContain('prompt');
    expect(buildAntigravityArgs({ cwd: '/tmp', userPrompt: 'fresh', sessionId: 'stale' })).not.toContain('--conversation');
  });

  it.each([undefined, '', '   '])('omits an absent or blank model (%s)', (model) => {
    expect(buildAntigravityArgs({ cwd: tmpdir(), userPrompt: 'test', model })).not.toContain('--model');
  });

  it('frames a stdin turn the way agy 1.4.0 reads it', () => {
    expect(antigravityUserFrame('hi\n"there"')).toBe('{"event":"user","message":{"content":"hi\\n\\"there\\""}}\n');
  });

  it('runs the bundled dry-run mock with no real CLI and emits both protocols', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AGY_BIN', '');
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const session = new AntigravityRunner().startSession(
      { cwd: tmpdir(), userPrompt: 'test' },
      (e) => v1.push(e),
      { onUiEvent: (e) => v2.push(e), autoEndAfterFirstTurn: true },
    );
    const result = await session.result;
    expect(result.text).toContain('CEZ:DONE');
    expect(result.tokensUsed).toBe(15);
    expect(result.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(v1.some((e) => e.type === 'session')).toBe(true);
    expect(v1.filter((e) => e.type === 'turn-end')).toHaveLength(1);
    expect(v2.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'next' }])).toBe(false);
  });

  it('keeps one process across turns and delivers the system prompt on stdin', async () => {
    const bin = await script(echoAgy('`pid=${process.pid} got=${content}`'));
    const v1: AgentEvent[] = [];
    let turnEnds = 0;
    let onTurnEnd: () => void = () => {};
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd: tmpdir(), userPrompt: 'first', systemPrompt: 'rules' },
      (e) => {
        v1.push(e);
        if (e.type === 'turn-end') {
          turnEnds += 1;
          onTurnEnd();
        }
      },
    );
    await new Promise<void>((resolve) => { onTurnEnd = resolve; });
    expect(session.open).toBe(true);
    expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
    await new Promise<void>((resolve) => { onTurnEnd = resolve; });
    session.end();
    const result = await session.result;
    const texts = v1.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('got=rules\n\n---\n\nfirst');
    expect(texts[1]).toContain('got=second');
    expect(texts[0]!.match(/pid=\d+/)![0]).toBe(texts[1]!.match(/pid=\d+/)![0]);
    expect(turnEnds).toBe(2);
    expect(result.tokensUsed).toBe(6);
    expect(result.sessionId).toBe('conv-1');
  });

  it('passes --conversation only when resuming, and keeps the resumed id', async () => {
    const bin = await script(echoAgy('JSON.stringify(argv)'));
    for (const resume of [false, true]) {
      const result = await new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'p', resume, sessionId: 'previous' });
      const argv: string[] = JSON.parse(result.text);
      expect(argv.includes('--conversation')).toBe(resume);
      if (resume) expect(argv[argv.indexOf('--conversation') + 1]).toBe('previous');
    }
  });

  it('notes images it cannot attach instead of failing the run', async () => {
    const bin = await script(echoAgy());
    const v1: AgentEvent[] = [];
    const result = await new AntigravityRunner({ bin }).run(
      { cwd: tmpdir(), userPrompt: 'look', images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
      (e) => v1.push(e),
    );
    expect(result.text).toBe('look');
    expect(v1).toContainEqual(expect.objectContaining({ type: 'note', message: expect.stringContaining('1 image(s)') }));
  });

  it('surfaces a turn-level ERROR result (an unknown --model) once, not as a bare exit code', async () => {
    // The live bad-model shape: an ERROR result with no init, then exit 1 (agy 1.4.0).
    const bin = await script(
      `console.log(JSON.stringify({event:'result',result:{conversation_id:'',status:'ERROR',response:'',error:'invalid model selection'}}));console.error('error: invalid model selection');process.exitCode=1;`,
    );
    const v1: AgentEvent[] = [];
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'x' }, (e) => v1.push(e))).rejects.toThrow(
      'invalid model selection',
    );
    expect(v1.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('reports a later exit with its own stderr, not an earlier turn error', async () => {
    const bin = await script(`
import { createInterface } from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let turn = 0;
for await (const _line of createInterface({ input: process.stdin })) {
  turn += 1;
  out({ event: 'result', result: turn === 1 ? { status: 'ERROR', error: 'first turn failed' } : { status: 'SUCCESS', response: 'ok' } });
  if (turn === 2) {
    console.error('crashed late');
    process.exit(5);
  }
}
`);
    let onTurnEnd: () => void = () => {};
    const session = new AntigravityRunner({ bin }).startSession({ cwd: tmpdir(), userPrompt: 'one' }, (e) => {
      if (e.type === 'turn-end') onTurnEnd();
    });
    await new Promise<void>((resolve) => { onTurnEnd = resolve; });
    expect(session.sendMessage([{ type: 'text', text: 'two' }])).toBe(true);
    await expect(session.result).rejects.toThrow('exited with code 5 — crashed late');
  });

  it('rejects a missing executable without crashing the host', async () => {
    await expect(new AntigravityRunner({ bin: '/no/such/agy' }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow(
      'not found on PATH',
    );
  });

  it('keeps stderr diagnostics when the process exits non-zero without a result', async () => {
    const bin = await script(`console.error('quota exhausted');process.exitCode=17;`);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow(
      'exited with code 17 — quota exhausted',
    );
  });

  it('kills a CLI ignoring SIGTERM when its deadline expires', async () => {
    const bin = await script(`process.on('SIGTERM',()=>{}); console.log('{"event":"init","init":{}}');setInterval(()=>{},1000);`);
    const runner = new AntigravityRunner({ bin, killGraceMs: 50 });
    await expect(runner.run({ cwd: tmpdir(), userPrompt: 'test', timeoutMs: 200 })).rejects.toThrow('timed out');
  });

  it('keeps a CLI that is still streaming past the inactivity window (cf2191f1)', async () => {
    const bin = await script(`
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ event: 'init', conversation_id: 'conv-1', init: {} });
let n = 0;
const t = setInterval(() => {
  out({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '.' } });
  if (++n === 8) {
    clearInterval(t);
    out({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'done' } });
    process.exit(0);
  }
}, 50);
`);
    const runner = new AntigravityRunner({ bin, killGraceMs: 50 });
    await expect(
      runner.run({ cwd: tmpdir(), userPrompt: 'test', timeoutMs: 200 }),
    ).resolves.toMatchObject({ sessionId: 'conv-1' });
  });

  it('treats a deliberate interrupt as cancellation, not a failure', async () => {
    const bin = await script(
      `console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:'ready'}}));setInterval(()=>{},1000);`,
    );
    const events: UiEvent[] = [];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const session = new AntigravityRunner({ bin, killGraceMs: 50 }).startSession({ cwd: tmpdir(), userPrompt: 'test' }, undefined, {
      onUiEvent: (event) => {
        events.push(event);
        if (event.type === 'item.started') ready();
      },
    });
    await started;
    session.interrupt();
    await expect(session.result).resolves.toMatchObject({ tokensUsed: 0 });
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'cancelled' });
  });

  it('fails fast on a sign-in prompt', async () => {
    const bin = await script(`console.error('Authentication required');setInterval(()=>{},1000);`);
    await expect(new AntigravityRunner({ bin, killGraceMs: 50 }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow(
      'authentication failed',
    );
    expect(isRuntimeProviderAuthFailure('Antigravity authentication failed — run agy')).toBe(true);
  });

  it('uses CEZ_AGY_BIN when no explicit binary was supplied, and an explicit binary over it', async () => {
    vi.stubEnv('CEZ_AGY_BIN', await script(echoAgy()));
    await expect(new AntigravityRunner().run({ cwd: tmpdir(), userPrompt: 'env' })).resolves.toMatchObject({ text: 'env' });
    vi.stubEnv('CEZ_AGY_BIN', '/do/not/spawn');
    const bin = await script(echoAgy());
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'explicit' })).resolves.toMatchObject({ text: 'explicit' });
  });

  it('discovers account-specific model slugs from `agy models` without importing the banner', () => {
    // Live agy 1.4.0 output, verbatim.
    const live = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';
    expect(parseAntigravityModelsOutput(live)).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: '' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', description: '' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', description: '' },
    ]);
  });
});
