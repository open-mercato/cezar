import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Review finding (2026-07-27): no agent transport listened for 'error' on the
 * child's stdin.
 *
 * A failed pipe write does not throw at the call site — libuv reports it
 * asynchronously as an 'error' event on the stream, so the `try/catch` wrapped
 * around `child.stdin.write(...)` never sees it. An EventEmitter 'error' with no
 * listener is an uncaught exception, and there is no `process.on('uncaughtException')`
 * anywhere in the codebase, so the whole server dies: RunManager shares the
 * process with the HTTP server, so every concurrent run goes with it.
 *
 * The trigger needs nothing exotic — a CLI that exits while a turn is still
 * buffered in the pipe. Cancel, the wall-clock kill, the EOF watchdog, or an
 * expired provider login all produce it, and multi-MB payloads (pasted
 * screenshots ride the same stdin line) sit far past the 64 KB pipe buffer.
 */
describe('child stdin EPIPE', () => {
  const runChild = (script: string): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stderr }));
    });

  // The payload must exceed the pipe buffer so the write stays queued and the
  // failure arrives asynchronously — that is the whole point.
  const payload = "'x'.repeat(8_000_000)";
  // The child must be ALIVE when the write is queued and exit while it is still
  // in flight — that is the real shape (a CLI killed or dying mid-turn). A child
  // that is already reaped has its stdio socket destroyed, which fails
  // differently and is not the hazard.
  const target = `spawn('/bin/sh', ['-c', 'sleep 0.3; exit 1'])`;

  it('kills the host process when nothing listens (the bug)', async () => {
    const { code, stderr } = await runChild(
      `const {spawn}=require('node:child_process');` +
        `const c=${target};` +
        `try{c.stdin.write(${payload})}catch(e){console.error('SYNC-CATCH')}` +
        `setTimeout(()=>process.exit(0),1500);`,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('EPIPE');
    // The synchronous catch never fires — proof that try/catch is not the fix.
    expect(stderr).not.toContain('SYNC-CATCH');
  }, 20_000);

  it('survives with the listener the runners now attach (the fix)', async () => {
    const { code, stderr } = await runChild(
      `const {spawn}=require('node:child_process');` +
        `const c=${target};` +
        `c.stdin.on('error',()=>{});` +
        `try{c.stdin.write(${payload})}catch{}` +
        `setTimeout(()=>process.exit(0),1500);`,
    );

    expect(code).toBe(0);
    expect(stderr).not.toContain('EPIPE');
  }, 20_000);
});

describe('every agent transport guards its child stdin', () => {
  const read = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8');

  it.each([
    ['claude-cli-runner.ts', 'claude-cli-runner.ts'],
    ['codex-app-server-transport.ts', 'codex-app-server-transport.ts'],
  ])('%s attaches a stdin error listener', (_name, file) => {
    expect(read(file)).toMatch(/(child|this\.child)\.stdin\.on\('error'/);
  });

  it('no transport relies on try/catch alone around a stdin write', () => {
    // Guard against a future edit deleting the listener and leaving the
    // (useless) synchronous catch behind as though it were the protection.
    for (const file of ['claude-cli-runner.ts', 'codex-app-server-transport.ts']) {
      const source = read(file);
      if (!source.includes('stdin.write')) continue;
      expect(source).toMatch(/stdin\.on\('error'/);
    }
  });
});
