import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sandboxRuntimeCliPath } from './claude-guard.js';
import { runValidationCommands } from './runtime.js';

function installedOnMac(): boolean {
  if (process.platform !== 'darwin') return false;
  try { return Boolean(sandboxRuntimeCliPath()); } catch { return false; }
}

afterEach(() => vi.unstubAllEnvs());

it.skipIf(!installedOnMac())('allows project output while isolating checks from host files and the host listener', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'cez-validation-project-'));
  const home = mkdtempSync(join(tmpdir(), 'cez-validation-host-'));
  const external = join(home, 'fixture.txt');
  const server = createServer((socket) => socket.end());
  writeFileSync(external, 'host fixture');
  vi.stubEnv('HOME', home);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
    writeFileSync(join(checkout, 'check.cjs'), `
      const assert = require('node:assert/strict');
      const { readFileSync, writeFileSync } = require('node:fs');
      const { connect } = require('node:net');
      const outside = ${JSON.stringify(external)};
      assert.throws(() => readFileSync(outside));
      assert.throws(() => writeFileSync(outside, 'unexpected update'));
      const socket = connect(${address.port}, '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); process.exitCode = 1; });
      socket.on('error', () => writeFileSync('check-result', 'isolated'));
    `);
    const [check] = await runValidationCommands(['node check.cjs'], checkout, { timeoutMs: 6_000 });
    expect(check).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(readFileSync(join(checkout, 'check-result'), 'utf8')).toBe('isolated');
    expect(readFileSync(external, 'utf8')).toBe('host fixture');
  } finally {
    server.close();
    rmSync(checkout, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
