import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectEnvironment } from './backend-detect.ts';

/**
 * The opencode probe's 1.x/2.x gate.
 *
 * The runner speaks 2.x's `/api` HTTP+SSE wire; a 1.x CLI exposes none of it,
 * and npm `opencode-ai@latest` still resolves to 1.18 — so a bare `opencode`
 * on PATH can be a 1.x install. Reporting that "available" turns an honest
 * "install 2.x" into every request 404ing mid-run.
 */
describe('backend-detect gates the opencode CLI on the 2.x line', () => {
  const saved = { bin: process.env.CEZ_OPENCODE_BIN, dry: process.env.CEZ_DRY_RUN };
  let dir: string;

  /** A stand-in `opencode` that prints exactly `line` for any argument. */
  function fakeOpencode(line: string): string {
    const file = join(dir, `opencode-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
    return file;
  }

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN; // real probe, not the mock short-circuit
    dir = mkdtempSync(join(tmpdir(), 'cez-opencode-probe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.bin === undefined) delete process.env.CEZ_OPENCODE_BIN;
    else process.env.CEZ_OPENCODE_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  async function opencodeCheck() {
    const checks = await detectEnvironment();
    return checks.find((c) => c.name === 'opencode');
  }

  it('reports a 2.x CLI available with its version', async () => {
    process.env.CEZ_OPENCODE_BIN = fakeOpencode('opencode v2.0.22');
    const check = await opencodeCheck();
    expect(check?.available).toBe(true);
    expect(check?.version).toBe('opencode v2.0.22');
  });

  it('marks the 1.x npm line unavailable and names the fix', async () => {
    process.env.CEZ_OPENCODE_BIN = fakeOpencode('1.18.34');
    const check = await opencodeCheck();
    expect(check?.available).toBe(false);
    expect(check?.hint).toContain('1.x');
    expect(check?.hint).toContain('opencode upgrade');
  });
});
