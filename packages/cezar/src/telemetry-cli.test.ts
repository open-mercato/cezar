import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTelemetryCommand } from './telemetry-cli.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

describe('cezar telemetry', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
  let lines: string[];
  const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };

  beforeEach(() => {
    lines = [];
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-telemetry-cli-')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports a fresh machine as off and never asked', async () => {
    expect(await runTelemetryCommand([], io)).toBe(0);
    expect(lines[0]).toBe('telemetry: off (never asked)');
  });

  it('enables, then disables and deletes the install id', async () => {
    await runTelemetryCommand(['enable'], io);
    expect((await loadWorkspaceConfig()).telemetry?.consent).toBe('granted');
    await mergeWriteWorkspaceConfig((config) => {
      config.cezarId = '01920000-0000-7000-8000-000000000000';
    });
    await runTelemetryCommand(['disable'], io);
    const config = await loadWorkspaceConfig();
    expect(config.telemetry?.consent).toBe('denied');
    expect(config.cezarId).toBeUndefined();
  });

  it('inspects without sending', async () => {
    await runTelemetryCommand(['enable'], io);
    lines = [];
    expect(await runTelemetryCommand(['inspect'], io)).toBe(0);
    expect(lines.join('\n')).toContain('"indexKey": "<created on the first send>"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown subcommand', async () => {
    expect(await runTelemetryCommand(['maybe'], io)).toBe(1);
  });
});
