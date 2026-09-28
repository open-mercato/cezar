import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveTransport,
  probeAdvisorHttp,
  probeKimiSubscription,
} from './probe-transports.js';

describe('harness live probe transports', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.CEZ_TEST_KIMI_BIN;
    delete process.env.CEZ_TEST_ADVISOR_KEY;
    vi.unstubAllGlobals();
  });

  const kimiStub = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-kimi-probe-test-'));
    dirs.push(dir);
    const binary = join(dir, 'kimi');
    writeFileSync(
      binary,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "kimi test"',
        '  exit 0',
        'fi',
        'cat >/dev/null',
        'echo "OK"',
      ].join('\n'),
    );
    chmodSync(binary, 0o755);
    process.env.CEZ_TEST_KIMI_BIN = binary;
    return binary;
  };

  it.skipIf(process.platform === 'win32')('probes the actual no-tools Kimi subscription completion path', async () => {
    const binary = kimiStub();
    const verdict = await probeKimiSubscription({
      model: 'kimi-code/k3',
      binaryEnv: 'CEZ_TEST_KIMI_BIN',
    });
    expect(verdict).toEqual({
      status: 'ready',
      detail: `round-trip ok via ${binary}`,
    });
  });

  it.skipIf(process.platform === 'win32')('routes Kimi preset advisors through the live subscription probe', async () => {
    kimiStub();
    const transport = createLiveTransport({
      advisors: {
        kimi: {
          model: 'kimi-code/k3',
          preset: 'kimi-subscription',
          binaryEnv: 'CEZ_TEST_KIMI_BIN',
        },
      },
    });
    await expect(
      transport({ runner: 'harness', model: 'kimi', family: 'moonshot' }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('refuses a redirected auth-store binding before reading credentials or sending a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.CEZ_TEST_ADVISOR_KEY = 'test-only-sentinel';

    await expect(
      probeAdvisorHttp({
        adapter: 'preset',
        preset: 'opencode-zen',
        model: 'mimo-v2.5-free',
        endpoint: 'https://example.invalid/completions',
        credentialEnv: 'CEZ_TEST_ADVISOR_KEY',
        authStoreProvider: 'opencode',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('official preset, provider, and endpoint'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
