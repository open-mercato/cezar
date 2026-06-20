import { describe, expect, it } from 'vitest';
import { PersistentClaudeSession } from '../../src/agents/persistent-claude-session.js';
import { makeFakeSpawn } from './fake-spawn.js';

// A minimal `claude --input-format stream-json` transcript: one result
// envelope per phase. The session class reads NDJSON off stdout and
// resolves the in-flight `sendPhase` when it sees `type:'result'`.
function resultLine(text: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage: { input_tokens: inputTokens },
  });
}

describe('PersistentClaudeSession', () => {
  it('passes --session-id when not resuming and reports the same id back', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ stdoutLines: [resultLine('hi', 10)], exitCode: 0 });
    const session = new PersistentClaudeSession({
      systemPrompt: 's',
      sessionId: 'fresh-uuid',
      cwd: '/tmp',
      allowedTools: ['Read'],
      spawnFn,
      idleMs: 0, // disable idle timer for the test
    });
    session.start();
    expect(session.sessionId).toBe('fresh-uuid');
    const argv = calls[0].args;
    expect(argv).toContain('--session-id');
    expect(argv).toContain('fresh-uuid');
    expect(argv).not.toContain('--resume');
    await session.stop();
  });

  it('passes --resume when opts.resume is true', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ stdoutLines: [resultLine('hi', 10)], exitCode: 0 });
    const session = new PersistentClaudeSession({
      systemPrompt: 's',
      sessionId: 'existing-uuid',
      cwd: '/tmp',
      allowedTools: ['Read'],
      spawnFn,
      idleMs: 0,
      resume: true,
    });
    session.start();
    const argv = calls[0].args;
    expect(argv).toContain('--resume');
    expect(argv).toContain('existing-uuid');
    expect(argv).not.toContain('--session-id');
    await session.stop();
  });

  it('closeIfIdle closes the child cleanly without throwing on a fresh session', async () => {
    const { spawnFn } = makeFakeSpawn({ stdoutLines: [resultLine('hi', 10)], exitCode: 0 });
    const session = new PersistentClaudeSession({
      systemPrompt: 's',
      sessionId: 'sess-1',
      cwd: '/tmp',
      allowedTools: ['Read'],
      spawnFn,
      idleMs: 0,
    });
    session.start();
    // Idempotent — calling closeIfIdle without an in-flight phase should
    // not crash and should be a no-op when called again.
    session.closeIfIdle();
    session.closeIfIdle();
    await session.stop();
  });

  it('cleans up when start() throws (binary missing) so no zombie state leaks', () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    });
    const { spawnFn } = makeFakeSpawn({ error: enoent });
    const session = new PersistentClaudeSession({
      systemPrompt: 's',
      sessionId: 'sess-1',
      cwd: '/tmp',
      allowedTools: ['Read'],
      spawnFn,
      idleMs: 0,
      bin: 'claude-nonexistent',
    });
    // Spawn itself doesn't throw with our fake (it routes ENOENT through an
    // async `error` event), so start() returns; the error path is exercised
    // by sendPhase's reject. This test focuses on the synchronous spawn-throw
    // path — i.e. start() throwing — by injecting a spawnFn that throws.
    const throwingSpawn: typeof spawnFn = () => {
      throw enoent;
    };
    const session2 = new PersistentClaudeSession({
      systemPrompt: 's',
      sessionId: 'sess-2',
      cwd: '/tmp',
      allowedTools: ['Read'],
      spawnFn: throwingSpawn,
      idleMs: 0,
    });
    expect(() => session2.start()).toThrow(/CLI not found on PATH/);
    // A second `start()` is still allowed — no zombie state was kept.
    expect(() => session2.start()).toThrow(/CLI not found on PATH/);
  });
});
