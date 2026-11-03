import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync as realpathOf, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from './runner-factory.ts';
import {
  cursorLaunch,
  buildCursorArgs,
  CursorAgentRunner,
  mockCursorAgentPath,
} from './cursor-agent-runner.ts';
import { mapCursorStreamEvent } from './cursor-ui-mapper.ts';

describe('buildCursorArgs', () => {
  it('builds print-mode args with force and stream-json', () => {
    expect(buildCursorArgs({ userPrompt: 'hi' })).toEqual(
      expect.arrayContaining(['-p', '--force', '--output-format', 'stream-json']),
    );
    expect(buildCursorArgs({ userPrompt: 'hi' }).at(-1)).toBe('hi');
  });
});

describe('mapCursorStreamEvent', () => {
  it('maps assistant text and terminal result', () => {
    expect(
      mapCursorStreamEvent({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      }),
    ).toEqual([{ type: 'text', text: 'hello' }]);
    // `done` is owned by the runner (emitted once, post-loop) — the mapper's own contribution
    // to the terminal result frame is `turn-end`, not a second `done`.
    expect(mapCursorStreamEvent({ type: 'result', subtype: 'success', is_error: false })).toEqual([
      { type: 'turn-end' },
    ]);
  });
});

describe('createRunner(cursor)', () => {
  it('returns CursorAgentRunner', () => {
    const runner = createRunner('cursor');
    expect(runner.backend).toBe('cursor');
  });
});

describe('CursorAgentRunner mock bin', () => {
  it('feeds stream-json and emits text + done, with no duplicate terminal events', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cursor-runner-'));
    try {
      const events: Array<{ type: string }> = [];
      const runner = new CursorAgentRunner({ bin: mockCursorAgentPath(), timeoutMs: 15_000 });
      const result = await runner.run({ userPrompt: 'hi', cwd }, (e) => events.push(e));
      expect(result.text).toContain('mock: cursor');
      expect(events.map((e) => e.type)).toEqual(['session', 'text', 'turn-end', 'done']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects instead of crashing the process when the binary is missing', async () => {
    // Regression test for the unhandled 'error' event: spawn() reports ENOENT asynchronously,
    // not by throwing — without a synchronous listener this takes down the whole cezar process.
    const cwd = mkdtempSync(join(tmpdir(), 'cursor-runner-'));
    try {
      const runner = new CursorAgentRunner({ bin: '/nonexistent/agent-binary-xyz', timeoutMs: 15_000 });
      await expect(runner.run({ userPrompt: 'hi', cwd })).rejects.toThrow(/not found on PATH/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects on a result frame reporting is_error:true even though the process exits 0', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cursor-runner-'));
    try {
      const events: Array<{ type: string }> = [];
      const runner = new CursorAgentRunner({ bin: mockCursorAgentPath(), timeoutMs: 15_000 });
      await expect(runner.run({ userPrompt: 'mock:error', cwd }, (e) => events.push(e))).rejects.toThrow(
        /scripted failure/,
      );
      expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
      expect(events.some((e) => e.type === 'error')).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('cursorLaunch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-cursor-launch-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path: string, body: string) => {
    writeFileSync(join(dir, path), body);
    chmodSync(join(dir, path), 0o755);
  };
  mkdirSync(join(dir, 'v1'));
  mkdirSync(join(dir, 'bin'));
  write('v1/node', '');
  write('v1/index.js', '');
  write('v1/cursor-agent', '#!/usr/bin/env bash\nexec -a "$0" "$NODE_BIN" --use-system-ca "$SCRIPT_DIR/index.js" "$@"\n');
  symlinkSync(join(dir, 'v1', 'cursor-agent'), join(dir, 'bin', 'agent'));
  write('trampoline', '');
  const desktop = { platform: 'darwin' as const, hostEnv: { CEZ_DISCLAIM_EXEC: join(dir, 'trampoline') } };
  const env = { PATH: join(dir, 'bin'), NODE_COMPILE_CACHE: '/cache' };

  it("starts the launcher's own node in the desktop app, as the launcher would", () => {
    const real = join(realpathOf(dir), 'v1');
    expect(cursorLaunch('agent', ['-p'], env, desktop)).toEqual({
      program: join(real, 'node'),
      args: ['--use-system-ca', join(real, 'index.js'), '-p'],
      env: { ...env, CURSOR_INVOKED_AS: 'agent' },
    });
  });

  it('leaves the launcher alone outside the desktop app or when it is not the known one', () => {
    expect(cursorLaunch('agent', ['-p'], env, { platform: 'darwin', hostEnv: {} })).toEqual({ program: 'agent', args: ['-p'], env });
    write('v1/cursor-agent', '#!/usr/bin/env bash\nexec node elsewhere.js "$@"\n');
    expect(cursorLaunch('agent', ['-p'], env, desktop)).toEqual({ program: 'agent', args: ['-p'], env });
  });
});
