import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { AntigravityRunner, buildAntigravityArgs } from './antigravity-runner.ts';
import { createRunner } from './runner-factory.ts';
import { buildChildEnv } from './agent-env.ts';
import { parseAntigravityModelsOutput } from './antigravity-model-catalog.ts';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function script(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-agy-test-')); dirs.push(dir);
  const bin = join(dir, 'fake.mjs'); await writeFile(bin, source); return bin;
}
const success = `console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok',conversation_id:'conversation',usage:{input_tokens:2,output_tokens:1,total_tokens:3}}}));`;

describe('Antigravity runner', () => {
  it('registers the native runner seam and keeps unrelated credentials out', () => {
    expect(createRunner('antigravity')).toBeInstanceOf(AntigravityRunner);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/test-bus');
    vi.stubEnv('GOOGLE_API_KEY', 'unrelated');
    const env = buildChildEnv({ backend: 'antigravity' });
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/test-bus');
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });
  it('preserves prompt boundaries, system instructions, model and resume id', () => {
    const args = buildAntigravityArgs({ cwd: '/tmp', userPrompt: 'a "quoted" $(prompt)', systemPrompt: 'instructions', model: 'custom-model', resume: true, sessionId: 'conversation', additionalDirectories: ['/a b'] });
    expect(args).toEqual(['--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'custom-model', '--conversation', 'conversation', '--add-dir', '/a b', '-p', 'instructions\n\n---\n\na "quoted" $(prompt)']);
    expect(buildAntigravityArgs({ cwd: '/tmp', userPrompt: 'fresh', sessionId: 'stale' })).not.toContain('--conversation');
  });
  it('never launches a real binary without opt-in', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '0');
    const bin = await script(success);
    expect(() => new AntigravityRunner({ bin }).startSession({ cwd: tmpdir(), userPrompt: 'test' })).toThrow('CEZ_ANTIGRAVITY');
  });
  it('runs the bundled dry-run mock without opt-in and emits both protocols', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AGY_BIN', ''); vi.stubEnv('CEZ_ANTIGRAVITY', '0');
    const v1: AgentEvent[] = [], v2: UiEvent[] = [];
    const session = new AntigravityRunner().startSession({ cwd: tmpdir(), userPrompt: 'test' }, e => v1.push(e), { onUiEvent: e => v2.push(e) });
    const result = await session.result;
    expect(result.text).toContain('CEZ:DONE'); expect(result.tokensUsed).toBe(15);
    expect(result.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(v1.some(e => e.type === 'session')).toBe(true);
    expect(v2.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
    expect(session.open).toBe(false); expect(session.sendMessage([{ type: 'text', text: 'next' }])).toBe(false);
  });
  it('fails when an ERROR result exits zero and releases the serial slot', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:'rejected'}}));`);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow('rejected');
    const good = await script(success);
    expect((await new AntigravityRunner({ bin: good }).run({ cwd: tmpdir(), userPrompt: 'test' })).text).toBe('ok');
  });
  it('rejects missing executables without crashing the host', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    await expect(new AntigravityRunner({ bin: '/no/such/agy' }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow('Cannot start Antigravity');
  });
  it('rejects a truncated stream instead of reporting success', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.log('{"event":"init","init":{}}');console.log('malformed');`);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow('successful result');
  });
  it('kills a CLI ignoring SIGTERM when its deadline expires', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`process.on('SIGTERM',()=>{}); console.log('{"event":"init","init":{}}');setInterval(()=>{},1000);`);
    const runner = new AntigravityRunner({ bin, killGraceMs: 50 });
    await expect(runner.run({ cwd: tmpdir(), userPrompt: 'test', timeoutMs: 200 })).rejects.toThrow('timed out');
  });
  it('treats deliberate interruption as cancellation and closes the live transcript', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`process.on('SIGTERM',()=>{}); console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:'ready'}}));setInterval(()=>{},1000);`);
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const events: UiEvent[] = [];
    const session = new AntigravityRunner({ bin, killGraceMs: 50 }).startSession(
      { cwd: tmpdir(), userPrompt: 'test' }, event => { if (event.type === 'text') ready(); },
      { onUiEvent: event => events.push(event) },
    );
    await started;
    session.interrupt();
    await expect(session.result).resolves.toMatchObject({ text: 'ready' });
    expect(events).toContainEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' });
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'cancelled' });
  });
  it('fails fast on authentication prompts', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.error('Authentication required');setInterval(()=>{},1000);`);
    await expect(new AntigravityRunner({ bin, killGraceMs: 50 }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow('authentication required');
  });
  it('cancels a queued session before it can spawn', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`setTimeout(()=>{${success}},150);`);
    const first = new AntigravityRunner({ bin }).startSession({ cwd: tmpdir(), userPrompt: 'first' });
    const next = new AntigravityRunner({ bin: '/never/spawn' }).startSession({ cwd: tmpdir(), userPrompt: 'next' });
    next.interrupt();
    await first.result; expect((await next.result).text).toBe(''); expect(next.pid).toBeUndefined();
  });
  it.each([undefined, '', 'true'])('requires explicit opt-in when CEZ_ANTIGRAVITY is %s', async value => {
    vi.stubEnv('CEZ_ANTIGRAVITY', value);
    const bin = await script(success);
    expect(() => new AntigravityRunner({ bin }).startSession({ cwd: tmpdir(), userPrompt: 'test' })).toThrow('CEZ_ANTIGRAVITY');
  });
  it.each([undefined, '', '   '])('omits an absent or blank model (%s)', model => {
    expect(buildAntigravityArgs({ cwd: tmpdir(), userPrompt: 'test', model })).toEqual([
      '--output-format', 'stream-json', '--dangerously-skip-permissions', '-p', 'test',
    ]);
  });
  it.each([false, true])('passes the conversation to the process only when resuming (%s)', async resume => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:JSON.stringify(process.argv.slice(2))}}));`);
    const result = await new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'quoted "prompt"', resume, sessionId: 'previous' });
    const argv: string[] = JSON.parse(result.text);
    expect(argv.includes('--conversation')).toBe(resume);
    if (resume) expect(argv[argv.indexOf('--conversation') + 1]).toBe('previous');
    expect(argv.at(-1)).toBe('quoted "prompt"');
  });
  it('ignores a malformed line while preserving the next valid result', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.log('not json');${success}`);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).resolves.toMatchObject({ text: 'ok', tokensUsed: 3 });
  });
  it('preserves stderr diagnostics when a process exits without a result', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.error('quota exhausted');process.exitCode=17;`);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).rejects.toThrow('Antigravity exited without a successful result (code 17): quota exhausted');
  });
  it('does not interpret informational stderr as a failed successful result', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    const bin = await script(`console.error('loading model');${success}`);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).resolves.toMatchObject({ text: 'ok' });
  });
  it('uses CEZ_AGY_BIN when no explicit binary was supplied', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1');
    vi.stubEnv('CEZ_AGY_BIN', await script(success));
    await expect(new AntigravityRunner().run({ cwd: tmpdir(), userPrompt: 'test' })).resolves.toMatchObject({ sessionId: 'conversation' });
  });
  it('prefers an explicit binary over CEZ_AGY_BIN', async () => {
    vi.stubEnv('CEZ_ANTIGRAVITY', '1'); vi.stubEnv('CEZ_AGY_BIN', '/do/not/spawn');
    const bin = await script(success);
    await expect(new AntigravityRunner({ bin }).run({ cwd: tmpdir(), userPrompt: 'test' })).resolves.toMatchObject({ text: 'ok' });
  });
  it('discovers account-specific model slugs without importing prose as models', () => {
    expect(parseAntigravityModelsOutput('Fetching available models...\ngemini-custom-high\tGemini Custom\nclaude-custom\tClaude Custom\n')).toEqual([
      { id: 'gemini-custom-high', label: 'Gemini Custom', description: '' },
      { id: 'claude-custom', label: 'Claude Custom', description: '' },
    ]);
  });
});
