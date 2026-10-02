import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeJunieAuthentication } from './junie-auth-probe.ts';

const mockBin = fileURLToPath(new URL('../../scripts/mock-junie-acp.mjs', import.meta.url));
const previousAuthError = process.env.CEZ_MOCK_JUNIE_AUTH_ERROR;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousAuthError === undefined) delete process.env.CEZ_MOCK_JUNIE_AUTH_ERROR;
  else process.env.CEZ_MOCK_JUNIE_AUTH_ERROR = previousAuthError;
});

describe('probeJunieAuthentication', () => {
  it('reports connected only after authenticated model discovery succeeds', async () => {
    delete process.env.CEZ_MOCK_JUNIE_AUTH_ERROR;
    await expect(probeJunieAuthentication({ bin: mockBin, cwd: process.cwd() }))
      .resolves.toEqual({ connected: true });
  }, 15_000);

  it('keeps status unknown when authenticated discovery returns no models', async () => {
    const discover = vi.spyOn(await import('./junie-model-catalog.ts'), 'discoverJunieModels');
    discover.mockResolvedValueOnce([]);
    await expect(probeJunieAuthentication({ bin: mockBin, cwd: process.cwd() }))
      .resolves.toEqual({ connected: false, hint: 'Junie did not return any available models.' });
  });

  it('surfaces ACP authentication errors while redacting credential-like values', async () => {
    process.env.CEZ_MOCK_JUNIE_AUTH_ERROR = 'invalid token: bearer abc123';
    await expect(probeJunieAuthentication({
      bin: mockBin,
      cwd: process.cwd(),
      spawn: (_bin, cwd) => spawn(process.execPath, [mockBin], {
        cwd,
        env: { ...process.env, CEZ_MOCK_JUNIE_AUTH_ERROR: process.env.CEZ_MOCK_JUNIE_AUTH_ERROR },
      }) as ReturnType<typeof spawn> & import('node:child_process').ChildProcessWithoutNullStreams,
    }))
      .resolves.toEqual({
        connected: false,
        hint: 'Junie model verification failed: invalid token: [redacted] [redacted]',
      });
  }, 15_000);

  it('reports notInstalled, not a generic unknown, when the binary is missing (#M1)', async () => {
    const result = await probeJunieAuthentication({ bin: '/no/such/junie-binary', cwd: process.cwd() });
    expect(result.connected).toBe(false);
    expect(result.notInstalled).toBe(true);
    expect(result.hint).toContain('not found on PATH');
  });
});