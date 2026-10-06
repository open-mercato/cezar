import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { flushTelemetry, registerTelemetryContext, reportError, sendDailyPing, telemetryEnabled, telemetryRuntime, uuidv7 } from './telemetry.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';

describe('telemetry', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('names the launcher: the desktop shell is app, everything else cli', () => {
    vi.stubEnv('CEZ_DESKTOP', '');
    expect(telemetryRuntime()).toBe('cli');
    vi.stubEnv('CEZ_DESKTOP', '1');
    expect(telemetryRuntime()).toBe('app');
  });

  it('never sends from a test run unless forced', () => {
    expect(telemetryEnabled()).toBe(false);
    reportError(new Error('quiet'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one wide event: caller context first, then providers, then the process', async () => {
    vi.stubEnv('CEZ_TELEMETRY', '1');
    registerTelemetryContext(() => ({ 'runs.running': 2, source: 'provider-must-not-win' }));
    registerTelemetryContext(() => {
      throw new Error('a broken provider costs only its own slice');
    });
    reportError(new TypeError('wide event test'), { source: 'cockpit', 'page.route': '/tasks' }, {
      code: 'chunk_load_failed',
      fingerprint: 'cockpit:chunk_load_failed',
    });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/track\/error$/);
    const body = JSON.parse(String(init.body));
    expect(body.error).toMatchObject({ type: 'TypeError', message: 'wide event test', code: 'chunk_load_failed' });
    expect(body.fingerprint).toBe('cockpit:chunk_load_failed');
    expect(body.context).toMatchObject({ source: 'cockpit', 'page.route': '/tasks', 'runs.running': 2 });
    expect(typeof body.context['process.uptime_s']).toBe('number');
    expect(Object.keys(body.context).length).toBeLessThanOrEqual(50);
    expect(body.featureFlags).toMatchObject({ dispatch: true });
    expect(body.runtime).toBe('cli');
  });

  it('makes time-ordered v7 ids', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  describe('daily ping', () => {
    const sent = () => fetchMock.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, RequestInit];
      return { event: url.split('/').pop(), body: JSON.parse(String(init.body)) };
    });

    beforeEach(() => {
      vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-daily-')));
      vi.stubEnv('VITEST', ''); // behave like a real install
    });

    it('sends cezar_run once a day and remembers the day', async () => {
      await sendDailyPing();
      await sendDailyPing();
      expect(sent().map((s) => s.event)).toEqual(['cezar_run']);
      const config = await loadWorkspaceConfig();
      expect(sent()[0]!.body.indexKey).toBe(config.cezarId);
      expect(config.lastActiveOn).toBe(new Date().toISOString().slice(0, 10));
    });

    it('sends telemetry_opt_out without an install id when opted out', async () => {
      vi.stubEnv('CEZ_TELEMETRY', '0');
      await sendDailyPing();
      expect(sent().map((s) => s.event)).toEqual(['telemetry_opt_out']);
      expect(sent()[0]!.body.indexKey).toBeUndefined();
      expect((await loadWorkspaceConfig()).cezarId).toBeUndefined();
    });

    it('retries a failed send on the next check', async () => {
      fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 500 })));
      await sendDailyPing();
      await sendDailyPing();
      expect(sent().map((s) => s.event)).toEqual(['cezar_run', 'cezar_run']);
    });

    it('stays silent under CI or a dry run', async () => {
      vi.stubEnv('CI', '1');
      await sendDailyPing();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
