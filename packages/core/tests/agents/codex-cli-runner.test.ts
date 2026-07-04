import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodexCliRunner } from '../../src/agents/codex-cli-runner.js';
import { makeFakeSpawn } from './fake-spawn.js';

// A canned `codex exec --json` transcript. Codex emits one JSON event per line;
// envelopes here use the `{id, msg:{type, ...}}` shape. We mix in a flat one to
// exercise both handlers. Token usage arrives via a `token_count` event.
const TRANSCRIPT = [
  JSON.stringify({ id: '0', msg: { type: 'task_started' } }),
  JSON.stringify({
    id: '1',
    msg: { type: 'exec_command_begin', command: ['bash', '-lc', 'cat src/x.ts'] },
  }),
  JSON.stringify({
    id: '1',
    msg: { type: 'exec_command_end', output: 'export const x = 1;', exit_code: 0 },
  }),
  JSON.stringify({ id: '2', msg: { type: 'agent_message_delta', delta: 'Working' } }),
  JSON.stringify({
    id: '3',
    msg: {
      type: 'agent_message',
      message:
        'Analysis complete.\n\n{"summary":"x missing","suspectedFiles":["src/x.ts"],"hypothesis":"h","confidence":0.8}',
    },
  }),
  JSON.stringify({
    type: 'token_count',
    total_token_usage: { total_tokens: 2500, input_tokens: 2000, output_tokens: 500 },
  }),
  JSON.stringify({ id: '4', msg: { type: 'task_complete' } }),
];

const AnalyzerSchema = z.object({
  summary: z.string(),
  suspectedFiles: z.array(z.string()),
  hypothesis: z.string(),
  confidence: z.number(),
});

describe('CodexCliRunner', () => {
  it('parses the exec --json transcript into events, tool calls, and structured output', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ stdoutLines: TRANSCRIPT, exitCode: 0 });
    const runner = new CodexCliRunner({ spawnFn });
    const events: { type: string }[] = [];
    const res = await runner.run(
      {
        systemPrompt: 'You are the analyzer.',
        userPrompt: 'Find the root cause of #42.',
        cwd: '/work/wt',
        allowedTools: ['Bash', 'Edit'],
        model: 'gpt-5-codex',
        responseSchema: AnalyzerSchema,
      },
      (e) => events.push(e as { type: string }),
    );

    expect(res.parsed).toEqual({
      summary: 'x missing',
      suspectedFiles: ['src/x.ts'],
      hypothesis: 'h',
      confidence: 0.8,
    });
    expect(res.toolCalls).toEqual([
      { id: '1', name: 'Bash', input: { command: 'bash -lc cat src/x.ts' } },
    ]);
    expect(res.tokensUsed).toBe(2500);
    expect(res.budgetExceeded).toBe(false);

    expect(events).toContainEqual({
      type: 'tool-call',
      id: '1',
      tool: 'Bash',
      input: { command: 'bash -lc cat src/x.ts' },
    });
    expect(events).toContainEqual({
      type: 'tool-result',
      toolCallId: '1',
      result: 'export const x = 1;',
      isError: false,
    });
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });

    const argv = calls[0].args;
    expect(calls[0].command).toBe('codex');
    expect(calls[0].cwd).toBe('/work/wt');
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('--cd');
    expect(argv).toContain('/work/wt');
    expect(argv).toContain('-s');
    expect(argv).toContain('workspace-write');
    expect(argv).toContain('-m');
    expect(argv).toContain('gpt-5-codex');
    // System prompt is folded into the trailing prompt arg.
    expect(argv.at(-1)).toContain('You are the analyzer.');
    expect(argv.at(-1)).toContain('Find the root cause of #42.');
  });

  it('emits a one-time "no per-tool allowlist" note at the start of a run', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [JSON.stringify({ id: '0', msg: { type: 'task_complete' } })],
      exitCode: 0,
    });
    const runner = new CodexCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    await runner.run(
      {
        systemPrompt: 's',
        userPrompt: 'u',
        cwd: '/tmp',
        allowedTools: ['Bash'],
        bashAllowlist: ['npm test'],
      },
      (e) => events.push(e as { type: string; message?: string }),
    );
    const notes = events.filter(
      (e) => e.type === 'note' && (e.message ?? '').includes('no per-tool allowlist'),
    );
    expect(notes).toHaveLength(1);
  });

  it('times out a never-exiting subprocess: kills it and resolves with note + error', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [JSON.stringify({ id: '0', msg: { type: 'task_started' } })],
      neverExits: true,
    });
    const runner = new CodexCliRunner({ spawnFn, timeoutMs: 30 });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      { systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Bash'] },
      (e) => events.push(e as { type: string; message?: string }),
    );
    expect(events.some((e) => e.type === 'note' && (e.message ?? '').includes('timed out'))).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'error' && (e.message ?? '').includes('timed out'))).toBe(
      true,
    );
    expect(res.budgetExceeded).toBe(false);
  });

  it('emits a "token usage not reported" note when no token_count event arrived', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({ id: '0', msg: { type: 'task_started' } }),
        JSON.stringify({ id: '1', msg: { type: 'agent_message', message: 'all done' } }),
        JSON.stringify({ id: '2', msg: { type: 'task_complete' } }),
      ],
      exitCode: 0,
    });
    const runner = new CodexCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      { systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Bash'] },
      (e) => events.push(e as { type: string; message?: string }),
    );
    expect(res.tokensUsed).toBe(0);
    expect(
      events.some(
        (e) => e.type === 'note' && (e.message ?? '').includes('token usage not reported'),
      ),
    ).toBe(true);
  });

  it('skips a malformed stream line with a note instead of crashing', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [
        '<<< not json >>>',
        JSON.stringify({ id: '1', msg: { type: 'agent_message', message: '{"ok":true}' } }),
        JSON.stringify({ id: '2', msg: { type: 'task_complete' } }),
      ],
      exitCode: 0,
    });
    const runner = new CodexCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      {
        systemPrompt: 's',
        userPrompt: 'u',
        cwd: '/tmp',
        allowedTools: ['Bash'],
        responseSchema: z.object({ ok: z.boolean() }),
      },
      (e) => events.push(e as { type: string; message?: string }),
    );
    expect(res.parsed).toEqual({ ok: true });
    expect(events.some((e) => e.type === 'note' && (e.message ?? '').includes('unparseable'))).toBe(
      true,
    );
  });

  it('throws a clear error when the codex binary is missing', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn codex ENOENT'), {
      code: 'ENOENT',
    });
    const { spawnFn } = makeFakeSpawn({ error: enoent });
    const runner = new CodexCliRunner({ spawnFn });
    await expect(
      runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Bash'] }),
    ).rejects.toThrow(/codex CLI not found on PATH/);
  });

  it('surfaces a codex error event', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({ id: '0', msg: { type: 'task_started' } }),
        JSON.stringify({ id: '1', msg: { type: 'error', message: 'model overloaded' } }),
      ],
      exitCode: 0,
    });
    const runner = new CodexCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    await runner.run(
      { systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Bash'] },
      (e) => events.push(e as { type: string; message?: string }),
    );
    expect(
      events.some((e) => e.type === 'error' && (e.message ?? '').includes('model overloaded')),
    ).toBe(true);
  });
});
