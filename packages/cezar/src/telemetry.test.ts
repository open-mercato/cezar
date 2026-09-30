import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerTelemetryContext, reportError, telemetryEnabled } from './telemetry.ts';

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

  it('never sends from a test run unless forced', () => {
    expect(telemetryEnabled()).toBe(false);
    reportError(new Error('quiet'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one wide event: caller context first, then providers, then the process', () => {
    vi.stubEnv('CEZ_TELEMETRY', '1');
    registerTelemetryContext(() => ({ 'runs.running': 2, source: 'provider-must-not-win' }));
    registerTelemetryContext(() => {
      throw new Error('a broken provider costs only its own slice');
    });
    reportError(new TypeError('wide event test'), { source: 'cockpit', 'page.route': '/tasks' }, {
      code: 'chunk_load_failed',
      fingerprint: 'cockpit:chunk_load_failed',
    });

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
  });
});
