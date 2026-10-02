import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { detectEnvironment } from './backend-detect.ts';
import { createRunner } from './runner-factory.ts';
import { buildKiloArgs, KiloRunner, resolveKiloBin, resolveKiloRunBin } from './kilo-runner.ts';

/**
 * The `kilo` runner: Kilo Code CLI slotted into the runner seam as ONE class.
 * These lock the seam-level guarantees — the factory hands back a kilo runner,
 * detection degrades gracefully when the kilo CLI is absent, the headless
 * `kilo run --auto --format json` argv is exact, and the dry-run mock emits
 * the normalized streams every backend shares.
 */

describe('createRunner returns the kilo runner', () => {
  it('maps the "kilo" id to a KiloRunner with backend "kilo"', () => {
    const runner = createRunner('kilo');
    expect(runner).toBeInstanceOf(KiloRunner);
    expect(runner.backend).toBe('kilo');
  });
});

describe('backend-detect handles an absent kilo CLI', () => {
  const saved = { bin: process.env.CEZ_KILO_BIN, dry: process.env.CEZ_DRY_RUN };

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN; // real probe, not the mock short-circuit
    process.env.CEZ_KILO_BIN = join(tmpdir(), 'cez-kilo-does-not-exist-xyz');
  });
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CEZ_KILO_BIN;
    else process.env.CEZ_KILO_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  it('reports kilo as unavailable with a hint, and never rejects (no boot failure)', async () => {
    const checks = await detectEnvironment();
    const kilo = checks.find((c) => c.name === 'kilo');
    expect(kilo).toBeDefined();
    expect(kilo!.available).toBe(false);
    expect(kilo!.hint).toContain('kilo');
  });
});

describe('a dry-run kilo session emits normalized AgentEvents', () => {
  const saved = process.env.CEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1'; // swap in the shared mock CLI
    cwd = mkdtempSync(join(tmpdir(), 'cez-kilo-run-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('streams text, a session id and a terminal done over the mock', async () => {
    const runner = new KiloRunner();
    expect(runner.backend).toBe('kilo');

    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate the login redirect bug', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('session');
    // Every backend's stream is terminated by exactly one `done`.
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.sessionId).toBe('mock-kilo-session');
  });
});

describe('kilo run argv', () => {
  it('uses autonomous headless json mode with provider/model verbatim', () => {
    expect(
      buildKiloArgs({
        userPrompt: 'task',
        systemPrompt: 'Keep changes focused.',
        model: 'openai/gpt-5.4',
      }),
    ).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '--model',
      'openai/gpt-5.4',
      'Keep changes focused.\n\n---\n\ntask',
    ]);
  });

  it('sends no model flag when the run leaves the choice to the CLI', () => {
    expect(buildKiloArgs({ userPrompt: 'task' })).toEqual(['run', '--auto', '--format', 'json', 'task']);
  });

  it('resolves the CEZ_KILO_BIN override for detection and runs, with a dry-run mock for turns', () => {
    expect(resolveKiloBin('/opt/kilo')).toBe('/opt/kilo');
    process.env.CEZ_KILO_BIN = '/tools/kilo custom';
    try {
      expect(resolveKiloBin()).toBe('/tools/kilo custom');
      expect(resolveKiloRunBin()).toBe('/tools/kilo custom');
    } finally {
      delete process.env.CEZ_KILO_BIN;
    }
    expect(resolveKiloBin()).toBe('kilo');
  });
});
