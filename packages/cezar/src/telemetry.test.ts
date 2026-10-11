import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEV_TELEMETRY_SERVICE, deviceSid, flushTelemetry, initTelemetry, installCrashReporter, scrub, stampedTelemetryService, registerTelemetryContext, reportError, sendDailyPing, telemetryEnabled, telemetryRuntime, telemetryVersion, track, uuidv7 } from './telemetry.ts';
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

  it('sends the release and channel, never the exact build', () => {
    expect(telemetryVersion('0.14.0')).toBe('0.14.0');
    expect(telemetryVersion('0.14.0-nightly.20261007.63')).toBe('0.14.0-nightly');
    expect(telemetryVersion('0.14.0-pr1322.2590')).toBe('0.14.0-pr');
    expect(telemetryVersion('0.9.2-pr743.1156.2')).toBe('0.9.2-pr');
    expect(telemetryVersion('0.13.0+cez-207a3912')).toBe('0.13.0-dev');
    expect(telemetryVersion('0.14.0', true)).toBe('0.14.0-dev');
    expect(telemetryVersion('0.14.0-rc.1')).toBe('0.14.0-dev');
    expect(telemetryVersion('garbage')).toBe('unknown');
  });

  it('uses the release stamp when present, otherwise the development service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-stamp-'));
    const file = join(dir, 'telemetry-service.json');
    expect(stampedTelemetryService(file)).toBeUndefined(); // no stamp: a dev build
    writeFileSync(file, JSON.stringify({ service: 'cezar' }));
    expect(stampedTelemetryService(file)).toBe('cezar');
    writeFileSync(file, JSON.stringify({ service: 'has spaces!' }));
    expect(stampedTelemetryService(file)).toBeUndefined();
    // This test run is unstamped, so what goes out is the development service.
    vi.stubEnv('CEZ_TELEMETRY', '1');
    vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-svc-')));
    track('app_start');
    await flushTelemetry();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.service).toBe(DEV_TELEMETRY_SERVICE);
  });

  it('makes time-ordered v7 ids', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('keys a device as <cezarId>:<sid>, the process as the bare cezarId', async () => {
    vi.stubEnv('CEZ_TELEMETRY', '1');
    vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-sid-')));
    const sid = uuidv7();
    track('settings_view', {}, { sid: deviceSid(sid) });
    track('app_start');
    reportError(new Error('device error'), {}, { sid: deviceSid(sid) });
    await flushTelemetry();
    const { cezarId } = await loadWorkspaceConfig();
    const keys = fetchMock.mock.calls.map((c) => {
      const body = JSON.parse(String((c as unknown as [string, RequestInit])[1].body));
      return body.indexKey ?? body.user.id;
    });
    expect(keys).toEqual([`${cezarId}:${sid}`, cezarId, `${cezarId}:${sid}`]);
    expect(keys[0]!.length).toBeLessThanOrEqual(96);
  });

  it('ignores a device header that is not a v7 uuid', () => {
    expect(deviceSid('../../etc')).toBeUndefined();
    expect(deviceSid(crypto.randomUUID())).toBeUndefined(); // v4
    expect(deviceSid(undefined)).toBeUndefined();
  });

  it('scrubs the working directory, the temp dir and the home directory, longest first', () => {
    const text = `ENOENT '${join(process.cwd(), 'src/a.ts')}' '${join(tmpdir(), 'x')}' '${join(homedir(), 'notes')}'`;
    const out = scrub(text);
    expect(out).toContain(`'${join('<repo>', 'src/a.ts')}'`);
    expect(out).toContain(`'${join('<tmp>', 'x')}'`);
    expect(out).toContain(`'${join('~', 'notes')}'`);
    expect(out).not.toContain(homedir());
  });

  it('masks a registered project root outside the home directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-roots-'));
    vi.stubEnv('CEZ_HOME', home);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [{ id: 'w', root: '/srv/work/acme-shop', name: 'acme', addedAt: '2026-10-11T00:00:00Z', lastOpenedAt: '2026-10-11T00:00:00Z', source: 'local' }] }));
    initTelemetry({ version: '0.0.0' });
    await vi.waitFor(() => expect(scrub('at /srv/work/acme-shop/x.ts')).toBe('at <repo>/x.ts'));
  });

  describe('crash reporter', () => {
    const before = process.listeners('uncaughtException');
    afterEach(() => {
      for (const l of process.listeners('uncaughtException')) if (!before.includes(l)) process.off('uncaughtException', l);
    });

    it('leaves Node’s own crash path alone when telemetry is off', () => {
      vi.stubEnv('CEZ_TELEMETRY', '0');
      installCrashReporter();
      expect(process.listeners('uncaughtException')).toEqual(before);
    });

    it('reports an uncaught exception before exiting 1', async () => {
      vi.stubEnv('CEZ_TELEMETRY', '1');
      vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-crash-')));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      installCrashReporter();
      const handler = process.listeners('uncaughtException').find((l) => !before.includes(l))!;
      handler(new Error('crash for the reporter'), 'uncaughtException');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
      expect(url).toMatch(/\/track\/error$/);
      expect(JSON.parse(String(init.body)).error.code).toBe('uncaught_exception');
      expect(printed).toHaveBeenCalled();
      exit.mockRestore();
      printed.mockRestore();
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined; // the handler set it on THIS test process
    });
  });

  describe('daily ping', () => {
    const sent = () => fetchMock.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, RequestInit];
      return { event: url.split('/').pop(), body: JSON.parse(String(init.body)) };
    });

    beforeEach(() => {
      vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-daily-')));
      // Behave like a real install — Actions sets CI, node:test sets NODE_TEST_CONTEXT.
      vi.stubEnv('VITEST', '');
      vi.stubEnv('CI', '');
      vi.stubEnv('NODE_TEST_CONTEXT', '');
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
