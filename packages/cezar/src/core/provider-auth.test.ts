import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthService,
  isRuntimeProviderAuthFailure,
  type ProviderCommandResult,
  type RunProviderCommand,
} from './provider-auth.js';

const connectedResults: Record<string, ProviderCommandResult> = {
  claude: { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 },
  codex: { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 },
  opencode: {
    stdout: [
      '┌  Credentials ~/.local/share/opencode/auth.json',
      '│',
      '●  Anthropic oauth',
      '│',
      '└  1 credential',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  },
};

const originalEnv = {
  CEZ_DRY_RUN: process.env.CEZ_DRY_RUN,
  CEZ_CLAUDE_BIN: process.env.CEZ_CLAUDE_BIN,
  CEZ_CODEX_BIN: process.env.CEZ_CODEX_BIN,
  CEZ_OPENCODE_BIN: process.env.CEZ_OPENCODE_BIN,
};

beforeEach(() => {
  delete process.env.CEZ_DRY_RUN;
  delete process.env.CEZ_CLAUDE_BIN;
  delete process.env.CEZ_CODEX_BIN;
  delete process.env.CEZ_OPENCODE_BIN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function resultFor(executable: string): ProviderCommandResult {
  if (executable === 'claude') return connectedResults.claude!;
  if (executable.includes('codex')) return connectedResults.codex!;
  return connectedResults.opencode!;
}

function runner(
  resolve: (executable: string, args: readonly string[]) => ProviderCommandResult = resultFor,
): RunProviderCommand {
  return vi.fn(async (executable, args) => resolve(executable, args));
}

function statuses(
  service: ProviderAuthService,
): Promise<Record<string, { status: string; hint?: string }>> {
  return service.status().then(({ providers }) => Object.fromEntries(
    providers.map(({ provider, status, hint }) => [provider, { status, hint }]),
  ));
}

describe('runtime provider authentication failures', () => {
  it.each([
    'claude CLI exited with code 1 — Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    'codex: turn failed: unauthorized',
    'ProviderAuthError: API key expired — run `opencode auth login`',
    'API Error: invalid API key',
    'AuthenticationError: expired api-key',
    '401 invalid x-api-key',
    'x-api-key is invalid',
    'expired API key',
    'API key expired',
    'access token is invalid',
    'authentication failed with HTTP 401',
  ])('recognizes an authoritative runtime auth rejection: %s', (message) => {
    expect(isRuntimeProviderAuthFailure(message)).toBe(true);
  });

  it.each([
    'claude CLI exited with code 1 — TypeScript check failed',
    'API Error: 429 rate limit exceeded',
    'the agent fixed a 401 response in src/auth.ts',
    'added coverage for invalid API key handling',
    'fixed a 401 response in the API key header parser',
    'investigated expired API-key validation before updating the note-event tests',
    'the API key rotation guide is invalid because its example is stale',
    'the invalid response parser documents an API key header',
    'network connection reset',
  ])('does not turn unrelated failures into credential failures: %s', (message) => {
    expect(isRuntimeProviderAuthFailure(message)).toBe(false);
  });
});

describe('provider auth parsers', () => {
  it('accepts only Claude JSON with loggedIn true as connected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'connected' } });
  });

  it('maps Claude loggedIn false, including exit 1 JSON, to disconnected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'disconnected' } });
  });

  it.each([
    ['loggedIn true on exit 7', '{"loggedIn":true}', 7],
    ['loggedIn false on exit 0', '{"loggedIn":false}', 0],
  ])('treats Claude %s as unknown', async (_case, stdout, exitCode) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout, stderr: '', exitCode }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'unknown' } });
  });

  it('treats malformed Claude JSON as unknown', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'claude'
        ? { stdout: '{not json', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'unknown' } });
  });

  it.each([
    'Logged in using ChatGPT',
    'Logged in using an API key',
    'Logged in using Agent Identity',
  ])('recognizes Codex connected output: %s', async (stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: `\u001B[32m${stdout}\u001B[0m`, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'connected' } });
  });

  it.each([
    'Logged in using ChatGPT',
    'Logged in using an API key - sk-proj-***ABCDE',
    'Logged in using access token',
    'Logged in using personal access token',
    'Logged in using Amazon Bedrock API key',
  ])('recognizes current Codex stderr output: %s', async (statusLine) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? {
          stdout: '',
          stderr: [
            'WARNING: experimental feature enabled',
            `\u001B[32m${statusLine}\u001B[0m`,
          ].join('\n'),
          exitCode: 0,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'connected' } });
  });

  it('recognizes current Codex not-logged-in stderr on exit 1', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? {
          stdout: '',
          stderr: ['WARNING: config migration available', 'Not logged in'].join('\n'),
          exitCode: 1,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'disconnected' } });
  });

  it.each([
    {
      case: 'duplicate answers',
      stdout: 'Logged in using ChatGPT',
      stderr: 'Logged in using ChatGPT',
    },
    {
      case: 'conflicting answers',
      stdout: 'Logged in using ChatGPT',
      stderr: 'Not logged in',
    },
  ])('treats Codex $case across output channels as unknown', async ({ stdout, stderr }) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout, stderr, exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it('never returns the masked Codex API-key identifier', async () => {
    const masked = 'sk-proj-***ABCDE';
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: '', stderr: `Logged in using an API key - ${masked}`, exitCode: 0 }
        : resultFor(executable)),
    });

    const response = await service.status();
    expect(response.providers.find(({ provider }) => provider === 'codex')).toEqual({
      provider: 'codex',
      status: 'connected',
    });
    expect(JSON.stringify(response)).not.toContain(masked);
  });

  it('does not accept known Codex connected output on an unexpected nonzero exit', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 7 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it.each([
    'Not logged in',
    'Run codex login to authenticate',
  ])('recognizes Codex disconnected output: %s', async (stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout, stderr: '', exitCode: 1 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'disconnected' } });
  });

  it('does not accept known Codex disconnected output on exit 0', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: 'Not logged in', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it('does not guess from unrecognized Codex output', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable.includes('codex')
        ? { stdout: 'Codex status: account maybe ready', stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'unknown' } });
  });

  it.each([
    [
      'one ANSI-styled credential',
      [
        '\u001B[90m┌  Credentials ~/.local/share/opencode/auth.json\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[36m●\u001B[0m  Acme Enterprise \u001B[2moauth\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[90m└\u001B[0m  1 credential',
      ].join('\n'),
    ],
    [
      'multiple arbitrary credential rows',
      [
        '┌  Credentials /srv/opencode/auth.json',
        '│',
        '●  Acme Enterprise oauth',
        '●  local-provider api',
        '●  Custom Gateway wellknown',
        '●  Another Provider api',
        '│',
        '└  4 credentials',
      ].join('\n'),
    ],
  ])('recognizes OpenCode %s as connected', async (_case, stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'connected' } });
  });

  it('recognizes an OpenCode decorated zero-credential list as disconnected', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? {
          stdout: [
            '┌  Credentials ~/.local/share/opencode/auth.json',
            '│',
            '└  0 credentials',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'disconnected' } });
  });

  it.each([
    [
      'one environment variable',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '│',
        '└  0 credentials',
        '',
        '┌  Environment',
        '│',
        '●  Anthropic ANTHROPIC_API_KEY',
        '│',
        '└  1 environment variable',
      ].join('\n'),
    ],
    [
      'multiple environment variables',
      [
        '\u001B[90m┌  Credentials /srv/opencode/auth.json\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[90m└\u001B[0m  0 credentials',
        '',
        '\u001B[90m┌  Environment\u001B[0m',
        '\u001B[90m│\u001B[0m',
        '\u001B[36m●\u001B[0m  Acme ACME_API_KEY',
        '\u001B[36m●\u001B[0m  Custom Gateway CUSTOM_TOKEN',
        '\u001B[90m│\u001B[0m',
        '\u001B[90m└\u001B[0m  2 environment variables',
      ].join('\n'),
    ],
  ])('recognizes OpenCode zero stored credentials plus %s as connected', async (_case, stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'connected' } });
  });

  it.each([
    [
      'a missing stored-credential summary',
      [
        '┌  Environment',
        '●  Acme ACME_API_KEY',
        '└  1 environment variable',
      ].join('\n'),
    ],
    [
      'duplicate stored-credential summaries',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '└  1 credential',
      ].join('\n'),
    ],
    [
      'conflicting environment summaries',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '┌  Environment',
        '└  1 environment variable',
        '└  2 environment variables',
      ].join('\n'),
    ],
    [
      'a malformed environment summary',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '┌  Environment',
        '└  environment variables: many',
      ].join('\n'),
    ],
    [
      'an environment summary without its block',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '└  1 environment variable',
      ].join('\n'),
    ],
    [
      'an unsafe environment count',
      [
        '┌  Credentials ~/.local/share/opencode/auth.json',
        '└  0 credentials',
        '┌  Environment',
        '└  9007199254740992 environment variables',
      ].join('\n'),
    ],
  ])('treats OpenCode output with %s as unknown', async (_case, stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: '', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });

  it('does not accept an OpenCode credential summary on an unexpected nonzero exit', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { ...connectedResults.opencode!, exitCode: 7 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });

  it.each([
    'New auth output format v99',
    ['┌  Credentials ~/.local/share/opencode/auth.json', '└  credentials: many'].join('\n'),
  ])('does not guess from OpenCode output without a valid count summary', async (stdout) => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'opencode'
        ? { stdout, stderr: 'error', exitCode: 0 }
        : { stdout: 'unrecognized', stderr: '', exitCode: 0 }),
    });

    await expect(statuses(service)).resolves.toMatchObject({ opencode: { status: 'unknown' } });
  });
});

describe('ProviderAuthService', () => {
  it('always returns claude, codex, opencode in descriptor order', async () => {
    const service = new ProviderAuthService({ runCommand: runner() });

    await expect(service.status()).resolves.toMatchObject({
      providers: [
        { provider: 'claude' },
        { provider: 'codex' },
        { provider: 'opencode' },
      ],
    });
  });

  it('runs the three status commands concurrently with a 10 second timeout', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable, args, timeoutMs) => {
      calls.push({ executable, args, timeoutMs });
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });
    const pending = service.status();

    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual([
      { executable: 'claude', args: ['auth', 'status', '--json'], timeoutMs: 10_000 },
      { executable: 'codex', args: ['login', 'status'], timeoutMs: 10_000 },
      { executable: 'opencode', args: ['auth', 'list'], timeoutMs: 10_000 },
    ]);
    release();
    await expect(pending).resolves.toBeDefined();
  });

  it('maps an ENOENT command failure to not-installed', async () => {
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'codex'
        ? { stdout: '', stderr: '', exitCode: null, errorCode: 'ENOENT' }
        : resultFor(executable)),
    });

    await expect(statuses(service)).resolves.toMatchObject({ codex: { status: 'not-installed' } });
  });

  it.each(['ETIMEDOUT', 'EACCES'])('maps %s to unknown without exposing raw output', async (errorCode) => {
    const secret = 'provider-auth-sentinel-secret';
    const service = new ProviderAuthService({
      runCommand: runner((executable) => executable === 'codex'
        ? {
          stdout: errorCode === 'EACCES' ? 'Logged in using ChatGPT' : secret,
          stderr: secret,
          exitCode: null,
          errorCode,
          timedOut: errorCode === 'ETIMEDOUT',
        }
        : resultFor(executable)),
    });

    const response = await service.status();
    const codex = response.providers.find(({ provider }) => provider === 'codex');
    expect(codex).toMatchObject({ provider: 'codex', status: 'unknown' });
    expect(codex?.hint).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it('reuses a completed result for five seconds', async () => {
    let now = 1_000;
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand, now: () => now });

    await service.status();
    now += 4_999;
    await service.status();
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('refresh bypasses a completed cache entry', async () => {
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand, now: () => 1_000 });

    await service.status();
    await service.status({ refresh: true });
    expect(runCommand).toHaveBeenCalledTimes(6);
  });

  it('keeps one incident id until an explicit matching clear and creates a new id afterward', async () => {
    const ids = ['incident-1', 'incident-2'];
    const service = new ProviderAuthService({
      platform: 'linux',
      runCommand: runner(),
      createAuthFailureId: () => ids.shift()!,
    });

    const first = service.reportRuntimeAuthFailure('claude');
    expect(first).not.toBeNull();
    if (!first) throw new Error('runtime incident was not created');
    expect(first).toEqual({
      transitioned: true,
      status: {
        provider: 'claude',
        status: 'disconnected',
        hint: 'Authentication was rejected during a run. Reconnect, then try again.',
        authFailureId: 'incident-1',
      },
    });
    expect(service.reportRuntimeAuthFailure('claude')).toEqual({
      transitioned: false,
      status: first.status,
    });
    await expect(service.status()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', authFailureId: 'incident-1' }),
      ]),
    });

    expect(service.clearRuntimeAuthFailure('claude', 'stale')).toBe(false);
    expect(service.clearRuntimeAuthFailure('claude', first.status.authFailureId)).toBe(true);

    expect(service.reportRuntimeAuthFailure('claude')).toMatchObject({
      status: { authFailureId: 'incident-2' },
    });
  });

  it('does not clear a runtime latch when an ordinary fresh probe finds credentials', async () => {
    const service = new ProviderAuthService({ runCommand: runner() });
    const report = service.reportRuntimeAuthFailure('claude');
    expect(report).not.toBeNull();
    if (!report) throw new Error('runtime incident was not created');
    const incident = report.status.authFailureId;

    await expect(service.status({ refresh: true })).resolves.toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: incident,
      })]),
    });
    expect(service.clearRuntimeAuthFailure('claude', incident)).toBe(true);
    await expect(service.status()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', status: 'connected' }),
      ]),
    });
  });

  it('applies a runtime failure that arrives while an ordinary probe is in flight', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable: string) => {
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });

    const pending = service.status();
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(3));
    service.reportRuntimeAuthFailure('claude');
    release();

    await expect(pending.then(({ providers }) => providers[0])).resolves.toMatchObject({
      provider: 'claude',
      status: 'disconnected',
    });
  });

  it('rejects a stale clear after a newer incident replaces it', async () => {
    const ids = ['incident-1', 'incident-2'];
    const service = new ProviderAuthService({
      runCommand: runner(),
      createAuthFailureId: () => ids.shift()!,
    });
    const firstReport = service.reportRuntimeAuthFailure('claude');
    expect(firstReport).not.toBeNull();
    if (!firstReport) throw new Error('runtime incident was not created');
    const first = firstReport.status.authFailureId;

    expect(service.clearRuntimeAuthFailure('claude', first)).toBe(true);
    const secondReport = service.reportRuntimeAuthFailure('claude');
    expect(secondReport).not.toBeNull();
    if (!secondReport) throw new Error('runtime incident was not created');
    const second = secondReport.status.authFailureId;

    expect(service.clearRuntimeAuthFailure('claude', first)).toBe(false);
    await expect(service.status()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', authFailureId: second }),
      ]),
    });
  });

  it('keeps CEZ_DRY_RUN connected and ignores runtime invalidation', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const createAuthFailureId = vi.fn(() => 'unused-incident');
    const service = new ProviderAuthService({ runCommand: runner(), createAuthFailureId });

    expect(service.reportRuntimeAuthFailure('claude')).toBeNull();
    expect(createAuthFailureId).not.toHaveBeenCalled();
    await expect(statuses(service)).resolves.toMatchObject({ claude: { status: 'connected' } });
  });

  it('coalesces ordinary and refresh callers while a probe is in flight', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable: string) => {
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });

    const ordinary = service.status();
    const refresh = service.status({ refresh: true });
    expect(refresh).toBe(ordinary);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(3));
    release();
    await expect(Promise.all([ordinary, refresh])).resolves.toHaveLength(2);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('gives ordinary callers one shared visible promise for a fresh probe after a latch', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (executable: string) => {
      await waiting;
      return resultFor(executable);
    });
    const service = new ProviderAuthService({ runCommand });
    service.reportRuntimeAuthFailure('claude');

    const refresh = service.status({ refresh: true });
    const ordinary = service.status();

    expect(refresh).toBe(ordinary);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(3));
    release();
    await expect(ordinary.then(({ providers }) => providers[0])).resolves.toMatchObject({
      provider: 'claude',
      status: 'disconnected',
    });
  });

  it('uses CEZ_CODEX_BIN and CEZ_OPENCODE_BIN for both probe and login commands', async () => {
    process.env.CEZ_CODEX_BIN = '/tools/codex custom';
    process.env.CEZ_OPENCODE_BIN = '/tools/opencode custom';
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand, platform: 'linux' });

    await service.status();
    expect(runCommand).toHaveBeenCalledWith('/tools/codex custom', ['login', 'status'], 10_000);
    expect(runCommand).toHaveBeenCalledWith('/tools/opencode custom', ['auth', 'list'], 10_000);
    expect(service.loginCommand('codex')).toBe("'/tools/codex custom' login");
    expect(service.loginCommand('opencode')).toBe("'/tools/opencode custom' auth login");
  });

  it('uses the documented CEZ_CLAUDE_BIN override for both probe and login commands', async () => {
    process.env.CEZ_CLAUDE_BIN = '/tools/claude custom';
    const runCommand = runner((executable) =>
      executable === '/tools/claude custom' ? connectedResults.claude! : resultFor(executable));
    const service = new ProviderAuthService({ runCommand, platform: 'linux' });

    await service.status();
    expect(runCommand).toHaveBeenCalledWith('/tools/claude custom', ['auth', 'status', '--json'], 10_000);
    expect(service.loginCommand('claude')).toBe("'/tools/claude custom' auth login");
  });

  it('renders POSIX and Windows login commands safely for executable special characters', () => {
    process.env.CEZ_CODEX_BIN = "a path/'codex'";
    process.env.CEZ_OPENCODE_BIN = 'C:\\Program Files\\op%en&co!de".exe';

    expect(new ProviderAuthService({ platform: 'linux' }).loginCommand('codex'))
      .toBe("'a path/'\\''codex'\\''' login");
    expect(new ProviderAuthService({ platform: 'win32' }).loginCommand('opencode'))
      .toBe('"C:\\Program Files\\op^%en^&co^!de^".exe" auth login');
  });

  it('reports all three providers connected in CEZ_DRY_RUN without executing a command', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const runCommand = runner();
    const service = new ProviderAuthService({ runCommand });

    await expect(service.status()).resolves.toEqual({
      providers: [
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'connected' },
        { provider: 'opencode', status: 'connected' },
      ],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
