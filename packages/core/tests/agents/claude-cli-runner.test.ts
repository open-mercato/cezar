import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeCodeCliRunner } from '../../src/agents/claude-cli-runner.js';
import { makeFakeSpawn } from './fake-spawn.js';

// A canned `claude -p --output-format stream-json --verbose` transcript:
// system/init → assistant tool_use → user tool_result → assistant text (JSON)
// → result (with usage).
const TRANSCRIPT = [
  JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read', 'Grep', 'Bash'] }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/x.ts' } }],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'export const x = 1;',
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Here is my analysis.\n\n{"summary":"x missing","suspectedFiles":["src/x.ts"],"hypothesis":"h","confidence":0.88}',
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 4000 },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result:
      'Here is my analysis.\n\n{"summary":"x missing","suspectedFiles":["src/x.ts"],"hypothesis":"h","confidence":0.88}',
    usage: { input_tokens: 1200, output_tokens: 80 },
    total_cost_usd: 0.012,
  }),
];

const AnalyzerSchema = z.object({
  summary: z.string(),
  suspectedFiles: z.array(z.string()),
  hypothesis: z.string(),
  confidence: z.number(),
});

describe('ClaudeCodeCliRunner', () => {
  it('parses the stream-json transcript into events, tool calls, and structured output (default transport)', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ stdoutLines: TRANSCRIPT, exitCode: 0 });
    // Phase 2 of the horizontal-scaling rollout flipped the default to
    // stream-json. Pin it here explicitly so the test still asserts the
    // happy path regardless of any future env-driven default shifts.
    const runner = new ClaudeCodeCliRunner({ spawnFn, transport: 'stream-json' });
    const events: { type: string }[] = [];
    const res = await runner.run(
      {
        systemPrompt: 'You are the analyzer.',
        userPrompt: 'Find the root cause of #42.',
        cwd: '/work/wt',
        allowedTools: ['Read', 'Grep', 'Bash'],
        model: 'claude-sonnet-4-6',
        responseSchema: AnalyzerSchema,
      },
      (e) => events.push(e as { type: string }),
    );

    expect(res.parsed).toEqual({
      summary: 'x missing',
      suspectedFiles: ['src/x.ts'],
      hypothesis: 'h',
      confidence: 0.88,
    });
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'Read', input: { file_path: 'src/x.ts' } }]);
    expect(res.tokensUsed).toBeGreaterThan(0);
    expect(res.budgetExceeded).toBe(false);

    expect(events).toContainEqual({
      type: 'tool-call',
      id: 'tu_1',
      tool: 'Read',
      input: { file_path: 'src/x.ts' },
    });
    expect(events).toContainEqual({
      type: 'tool-result',
      toolCallId: 'tu_1',
      result: 'export const x = 1;',
      isError: false,
    });
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });

    // argv sanity: stream-json transport reads the prompt over stdin (not
    // argv), keeps the per-call sandbox flags, and pins the cwd.
    const argv = calls[0].args;
    expect(calls[0].command).toBe('claude');
    expect(calls[0].cwd).toBe('/work/wt');
    expect(argv).toContain('--input-format');
    expect(argv).toContain('stream-json');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('Find the root cause of #42.');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('--append-system-prompt');
    expect(argv).toContain('You are the analyzer.');
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Read,Grep,Bash');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-4-6');
  });

  it('defaults to stream-json transport when no override is provided', async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 1 },
        }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] });
    const argv = calls[0].args;
    expect(argv).toContain('--input-format');
    expect(argv).toContain('stream-json');
    expect(argv).not.toContain('-p');
  });

  it('passes --session-id when the spec carries a sessionId without resume', async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 1 },
        }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const res = await runner.run({
      systemPrompt: 's',
      userPrompt: 'u',
      cwd: '/tmp',
      allowedTools: ['Read'],
      sessionId: 'abc-123',
    });
    expect(res.sessionId).toBe('abc-123');
    const argv = calls[0].args;
    expect(argv).toContain('--session-id');
    expect(argv).toContain('abc-123');
    expect(argv).not.toContain('--resume');
  });

  it('switches to --resume when spec.resume is set, and falls back to fresh start on resume failure', async () => {
    let attempt = 0;
    const capturedAttempts: Array<{ args: readonly string[] }> = [];
    const failingSpawn = makeFakeSpawn({
      stdoutLines: [],
      stderr: 'session not found',
      exitCode: 1,
    });
    const successSpawn = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 1 },
        }),
      ],
      exitCode: 0,
    });
    const spawnFn: import('../../src/agents/claude-cli-runner.js').SpawnFn = (cmd, args, opts) => {
      attempt += 1;
      capturedAttempts.push({ args });
      return (attempt === 1 ? failingSpawn.spawnFn : successSpawn.spawnFn)(cmd, args, opts);
    };

    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      {
        systemPrompt: 's',
        userPrompt: 'u',
        cwd: '/tmp',
        allowedTools: ['Read'],
        sessionId: 'sess-xyz',
        resume: true,
      },
      (e) => events.push(e as { type: string; message?: string }),
    );

    expect(res.sessionId).toBe('sess-xyz');
    // Two spawn attempts — first with --resume, second cold start with --session-id.
    expect(capturedAttempts.length).toBe(2);
    expect(capturedAttempts[0].args).toContain('--resume');
    expect(capturedAttempts[0].args).toContain('sess-xyz');
    expect(capturedAttempts[1].args).toContain('--session-id');
    expect(capturedAttempts[1].args).toContain('sess-xyz');
    expect(capturedAttempts[1].args).not.toContain('--resume');
    // Fallback emits a `note` so the cockpit shows the degraded path.
    expect(
      events.some((e) => e.type === 'note' && (e.message ?? '').includes('cross-host re-claim')),
    ).toBe(true);
  });

  it('throws a clear error when the claude binary is missing', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    });
    const { spawnFn } = makeFakeSpawn({ error: enoent });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await expect(
      runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] }),
    ).rejects.toThrow(/claude CLI not found on PATH/);
  });

  it('throws a clear error when the prompt exceeds ARG_MAX (E2BIG)', async () => {
    const e2big: NodeJS.ErrnoException = Object.assign(new Error('spawn claude E2BIG'), {
      code: 'E2BIG',
    });
    const { spawnFn } = makeFakeSpawn({ error: e2big });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await expect(
      runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] }),
    ).rejects.toThrow(/prompt too large for argv \(E2BIG\)/);
  });

  it('throws when the CLI exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init' })],
      stderr: 'fatal: not a git repository',
      exitCode: 1,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await expect(
      runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] }),
    ).rejects.toThrow(/claude CLI exited with code 1/);
  });

  it('maps allowedTools + bashAllowlist onto Bash(prefix:*) patterns in the argv', async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 1 },
        }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await runner.run({
      systemPrompt: 's',
      userPrompt: 'u',
      cwd: '/tmp',
      allowedTools: ['Read', 'Grep', 'Bash'],
      bashAllowlist: ['npm test', 'git status'],
    });
    const argv = calls[0].args;
    expect(argv).toContain('--allowedTools');
    const idx = argv.indexOf('--allowedTools');
    expect(argv[idx + 1]).toBe('Read,Grep,Bash(npm test:*),Bash(git status:*)');
  });

  it('passes a plain Bash entry when no bashAllowlist is given', async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 1 },
        }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await runner.run({
      systemPrompt: 's',
      userPrompt: 'u',
      cwd: '/tmp',
      allowedTools: ['Read', 'Bash'],
    });
    const argv = calls[0].args;
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Bash');
  });

  it('times out a never-exiting subprocess: kills it and resolves with note + error', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init' })],
      neverExits: true,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn, timeoutMs: 30 });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      { systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] },
      (e) => events.push(e as { type: string; message?: string }),
    );
    expect(events.some((e) => e.type === 'note' && (e.message ?? '').includes('timed out'))).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'error' && (e.message ?? '').includes('timed out'))).toBe(
      true,
    );
    expect(res.budgetExceeded).toBe(false);
    expect(res.parsed).toBeNull();
  });

  it('emits a "token usage not reported" note when the transcript carries no usage', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      { systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] },
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
        'this is not json',
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"ok":true}',
          usage: { input_tokens: 1 },
        }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const events: { type: string; message?: string }[] = [];
    const res = await runner.run(
      {
        systemPrompt: 's',
        userPrompt: 'u',
        cwd: '/tmp',
        allowedTools: ['Read'],
        responseSchema: z.object({ ok: z.boolean() }),
      },
      (e) => events.push(e as { type: string; message?: string }),
    );
    expect(res.parsed).toEqual({ ok: true });
    expect(events.some((e) => e.type === 'note' && (e.message ?? '').includes('unparseable'))).toBe(
      true,
    );
  });

  it('falls back to the result message text when no streamed assistant text arrived', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"verdict":"pass"}',
          usage: { input_tokens: 10 },
        }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const res = await runner.run({
      systemPrompt: 's',
      userPrompt: 'u',
      cwd: '/tmp',
      allowedTools: ['Read'],
      responseSchema: z.object({ verdict: z.string() }),
    });
    expect(res.parsed).toEqual({ verdict: 'pass' });
  });
});
