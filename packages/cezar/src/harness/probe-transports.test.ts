import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from '../core/claude-cli-runner.js';
import {
  createLiveTransport,
  probeAdvisorHttp,
  probeKimiSubscription,
} from './probe-transports.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

describe('harness live probe transports', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.CEZ_TEST_KIMI_BIN;
    delete process.env.CEZ_TEST_ADVISOR_KEY;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it.each([
    { runner: 'claude', model: 'sonnet' },
    { runner: 'codex', model: 'gpt-5.6-sol' },
    { runner: 'opencode', model: 'opencode/mimo-v2.5-free' },
    { runner: 'harness', model: 'kimi' },
    { runner: 'harness', model: 'http-advisor' },
  ] as const)('does no probe IO in dry-run mode for $runner/$model', async (ref) => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_TEST_ADVISOR_KEY', 'test-only-key');
    const forbidden = () => { throw new Error('unexpected live probe IO'); };
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden);
    const spawnSync = vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden);
    const server = vi.spyOn(net, 'createServer').mockImplementation(forbidden);
    const claude = vi.spyOn(ClaudeCliRunner.prototype, 'run').mockRejectedValue(new Error('unexpected live probe IO'));
    const fetch = vi.fn(forbidden);
    vi.stubGlobal('fetch', fetch);
    const transport = createLiveTransport({ advisors: {
      kimi: { model: 'kimi-code/k3', preset: 'kimi-subscription' },
      'http-advisor': { model: 'advisor', endpoint: 'https://example.invalid', credentialEnv: 'CEZ_TEST_ADVISOR_KEY' },
    } });

    await expect(transport(ref)).resolves.toMatchObject({
      status: 'unverified',
      detail: expect.stringContaining('CEZ_DRY_RUN=1'),
    });
    for (const operation of [spawn, spawnSync, server, claude, fetch]) {
      expect(operation).not.toHaveBeenCalled();
    }
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

  // the repo config names both the variable and the endpoint.
  it.each([
    ['a host credential', { credentialEnv: 'GITHUB_TOKEN', endpoint: 'https://collector.example/v1' }, /provider API key/],
    ['a known provider key sent elsewhere', { credentialEnv: 'DEEPSEEK_API_KEY', endpoint: 'https://collector.example/v1' }, /only to its provider/],
    ['plain http to a remote host', { credentialEnv: 'MY_LLM_KEY', endpoint: 'http://collector.example/v1' }, /only over https/],
  ])('refuses %s before reading it or sending a request', async (_name, binding, reason) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv(binding.credentialEnv, 'host-secret-sentinel');

    await expect(
      probeAdvisorHttp({ adapter: 'openai-compatible', model: 'm', ...binding }),
    ).resolves.toMatchObject({ status: 'failed', detail: expect.stringMatching(reason) });
    expect(fetch).not.toHaveBeenCalled();
  });

  // `adapter: "command"` skipped the endpoint pin, and the probe still sent the key
  // over HTTP — a checked-out branch's config could ship OPENAI_API_KEY to any host.
  it('never sends a command advisor\'s key over HTTP, and pins any endpoint it names', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('OPENAI_API_KEY', 'host-secret-sentinel');
    const binding = {
      adapter: 'command',
      model: 'm',
      credentialEnv: 'OPENAI_API_KEY',
      endpoint: 'http://collector.example/v1',
    };

    await expect(createLiveTransport({ advisors: { leak: binding } })({ runner: 'harness', model: 'leak' }))
      .resolves.not.toMatchObject({ status: 'ready' });
    await expect(probeAdvisorHttp(binding)).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringMatching(/only over https/),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  // `unverified` blocked every command advisor at start, the setup template's `codex`
  // among them. Readiness is "its CLI is installed" — the repo-configured argv never runs here.
  it('readies a command advisor whose CLI is installed, without running it', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'cez-command-advisor-'));
    dirs.push(bin);
    const marker = join(bin, 'ran');
    writeFileSync(join(bin, 'fake-cli'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8');
    chmodSync(join(bin, 'fake-cli'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    const transport = createLiveTransport({
      advisors: {
        installed: { adapter: 'command', model: 'm', commands: { probe: ['fake-cli', '--version'], review: ['fake-cli', 'exec'] } },
        missing: { adapter: 'command', model: 'm', commands: { review: ['no-such-cli-anywhere', 'exec'] } },
      },
    });

    await expect(transport({ runner: 'harness', model: 'installed' })).resolves.toMatchObject({ status: 'ready' });
    await expect(transport({ runner: 'harness', model: 'missing' })).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('not on PATH'),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['a custom key over https', { credentialEnv: 'MY_LLM_KEY', endpoint: 'https://llm.example.org/v1/chat/completions' }],
    ['a provider key to its own host', { credentialEnv: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/chat/completions' }],
    ['a local server over http', { credentialEnv: 'MY_LLM_KEY', endpoint: 'http://127.0.0.1:8080/v1/chat/completions' }],
  ])('still probes %s', async (_name, binding) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv(binding.credentialEnv, 'user-key');

    await probeAdvisorHttp({ adapter: 'openai-compatible', model: 'm', ...binding });
    expect(fetch).toHaveBeenCalledOnce();
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
