import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const moduleUrl = new URL('./process-signals.ts', import.meta.url).href;
const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));

function runWith(body: string) {
  const script = `import { watchOwnSignals } from ${JSON.stringify(moduleUrl)};\nwatchOwnSignals();\n${body}`;
  return spawnSync(tsx, ['--eval', script], { encoding: 'utf8', timeout: 20_000 });
}

describe.skipIf(process.platform === 'win32')('watchOwnSignals', () => {
  it('keeps Node\'s default exit when it is the only listener', () => {
    const result = runWith(`process.kill(process.pid, 'SIGTERM'); setTimeout(() => console.log('survived'), 2000);`);
    expect(result.stdout).not.toContain('survived');
    // tsx's wrapper relays the child's signal death as 128 + 15.
    expect(result.signal === 'SIGTERM' || result.status === 143).toBe(true);
  });

  it('only records beside a handler of the process\'s own', () => {
    const result = runWith(
      `process.on('SIGTERM', () => { console.log('handled'); process.exit(7); });\nprocess.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 2000);`,
    );
    expect(result.stdout).toContain('handled');
    expect(result.status).toBe(7);
  });
});
