import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginSession } from '@open-mercato/cezar-contract';
import { onAccountReconnected } from './account-reconnected.ts';
import type { LoginChild, LoginFetch, SpawnLogin } from './login-drivers/types.ts';
import { DRY_RUN_USER_CODE, LOGIN_SESSION_TTL_MS, LoginSessionManager, phoneSafeSession, type LoginSessionDeps } from './login-session.ts';
import type { ProviderId } from './provider-auth.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';

const SECRET = 'sk-SECRET-pasted-value-123';

class FakeChild implements LoginChild {
  writes: string[] = [];
  stdinClosed = false;
  killed = false;
  private outputs: Array<(text: string) => void> = [];
  private exits: Array<(code: number | null, error?: string) => void> = [];
  constructor(readonly executable: string, readonly args: readonly string[], readonly env: NodeJS.ProcessEnv) {}
  onOutput(listener: (text: string) => void) { this.outputs.push(listener); }
  onExit(listener: (code: number | null, error?: string) => void) { this.exits.push(listener); }
  write(text: string) { this.writes.push(text); }
  closeStdin() { this.stdinClosed = true; }
  kill() { this.killed = true; }
  print(text: string) { for (const l of this.outputs) l(text); }
  exit(code: number | null, error?: string) { for (const l of this.exits) l(code, error); }
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

function profile(provider: ProviderId, id = 'default'): ResolvedAgentProfile {
  return id === 'default'
    ? { id, provider, label: 'Default', configDir: `/home/u/.${provider}`, path: `/home/u/.${provider}`, isDefault: true }
    : { id, provider, label: id, configDir: `/accounts/${id}`, path: `/accounts/${id}`, isDefault: false };
}

function harness(overrides: Partial<LoginSessionDeps> = {}) {
  const children: FakeChild[] = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const spawn: SpawnLogin = (executable, args, { env }) => {
    const child = new FakeChild(executable, args, env);
    children.push(child);
    return child;
  };
  const deps: LoginSessionDeps = {
    resolveProfile: async (provider, profileId) => (profileId === 'missing'
      ? { error: `unknown ${provider} account: missing` }
      : { profile: profile(provider, profileId ?? 'default') }),
    loginCommand: (provider, configDir) => (configDir ? `CLAUDE_CONFIG_DIR='${configDir}' ${provider} login` : `${provider} login`),
    confirmConnected: vi.fn(async () => true),
    remoteAccountsEnabled: () => false,
    emit: (event, payload) => events.push({ event, payload }),
    openTerminal: vi.fn(async () => true),
    watchTerminal: vi.fn(),
    dryRun: () => false,
    spawn,
    browserShim: async () => null,
    ensureDir: async () => {},
    ...overrides,
  };
  const manager = new LoginSessionManager(deps);
  const sessions = () => events.filter((e) => e.event === 'agent-login').map((e) => e.payload as LoginSession);
  const last = () => sessions().at(-1)!;
  return { manager, deps, children, events, sessions, last };
}

const LOCAL = { local: true, phone: false };
const PHONE = { local: false, phone: true };
const HOSTED = { local: false, phone: false };

let resumedCalls: Array<{ provider: string; profileId: string }>;
let off: () => void;
beforeEach(() => {
  resumedCalls = [];
  off = onAccountReconnected((event) => {
    resumedCalls.push(event);
    return { runs: [{ projectId: 'p', runId: 'r1', title: 'Fix it' }], managers: [] };
  });
});
afterEach(() => {
  off();
  vi.useRealTimers();
});

describe('phoneSafeSession', () => {
  const base = { sessionId: 's', provider: 'cursor', method: 'terminal', phase: 'waiting', command: 'CURSOR_CONFIG_DIR=/home/u/.cezar/accounts/work agent login' } as const;
  it("drops a named account's command (its folder path) and keeps the default login's", () => {
    expect(phoneSafeSession({ ...base, profileId: 'work' } as LoginSession).command).toBeUndefined();
    expect(phoneSafeSession({ ...base, profileId: 'default' } as LoginSession).command).toBe(base.command);
  });
});

describe('hosted gate', () => {
  it('allows a local cockpit and a paired phone', async () => {
    const h = harness();
    expect((await h.manager.start({ provider: 'cursor' }, LOCAL)).ok).toBe(true);
    expect((await h.manager.start({ provider: 'codex', profileId: 'work' }, PHONE)).ok).toBe(true);
  });

  it('refuses hosted web without CEZ_REMOTE_AGENT_ACCOUNTS, with the command like Connect', async () => {
    const h = harness();
    expect(await h.manager.start({ provider: 'claude' }, HOSTED)).toEqual({
      ok: false, status: 409, error: 'Run this command on the machine hosting cezar.', command: 'claude login',
    });
    expect(h.children).toHaveLength(0);
  });

  it('refuses a named account on hosted web before resolving it, and names no path', async () => {
    const resolveProfile = vi.fn();
    const h = harness({ resolveProfile });
    const result = await h.manager.start({ provider: 'claude', profileId: 'work' }, HOSTED);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result).not.toHaveProperty('command');
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it('allows hosted web when the operator opted in', async () => {
    const h = harness({ remoteAccountsEnabled: () => true });
    expect((await h.manager.start({ provider: 'claude', profileId: 'work' }, HOSTED)).ok).toBe(true);
  });

  it('answers an unknown account with 400', async () => {
    const h = harness();
    expect(await h.manager.start({ provider: 'claude', profileId: 'missing' }, LOCAL)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('API keys', () => {
  it('are refused for any runner but Codex and OpenCode', async () => {
    const h = harness();
    expect(await h.manager.start({ provider: 'claude', method: 'key' }, LOCAL)).toMatchObject({ ok: false, status: 400 });
    const started = await h.manager.start({ provider: 'claude' }, PHONE);
    if (!started.ok) throw new Error('start failed');
    expect(await h.manager.input(started.session.sessionId, { apiKey: SECRET })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('claude', () => {
  it('relays the paste-code flow remotely and never echoes the code', async () => {
    const h = harness();
    const started = await h.manager.start({ provider: 'claude', profileId: 'work' }, PHONE);
    if (!started.ok) throw new Error('start failed');
    await flush();
    const child = h.children[0]!;
    expect(child.args).toEqual(['auth', 'login']);
    expect(child.env.CLAUDE_CONFIG_DIR).toBe('/accounts/work');
    child.print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\nPaste code here if prompted > ");
    expect(h.last()).toMatchObject({ method: 'paste', phase: 'needs-input' });
    expect(h.last().url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize/);

    const answered = await h.manager.input(started.session.sessionId, { code: SECRET });
    expect(answered.ok).toBe(true);
    expect(child.writes).toEqual([`${SECRET}\n`]);
    child.exit(0);
    await flush();
    expect(h.last()).toMatchObject({ phase: 'connected', resumed: { runs: [{ runId: 'r1' }] } });
    expect(resumedCalls).toEqual([{ provider: 'claude', profileId: 'work' }]);
    expect(h.events.find((e) => e.event === 'account-reconnected')?.payload).toMatchObject({ provider: 'claude', profileId: 'work' });
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    expect(JSON.stringify(answered)).not.toContain(SECRET);
  });

  it('opens the captured browser page locally', async () => {
    const urls = ['https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback'];
    const h = harness({ browserShim: async () => ({ dir: '/tmp/shim', urls: async () => urls, dispose: async () => {} }) });
    await h.manager.start({ provider: 'claude' }, LOCAL);
    await flush();
    expect(h.children[0]!.env.PATH?.startsWith('/tmp/shim')).toBe(true);
    await flush();
    expect(h.last()).toMatchObject({ method: 'browser', phase: 'waiting', url: urls[0] });
  });

  it('swallows the browser remotely: the shim is on PATH, but the phone gets the paste flow', async () => {
    const urls = ['https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback'];
    const h = harness({ browserShim: async () => ({ dir: '/tmp/shim', urls: async () => urls, dispose: async () => {} }) });
    await h.manager.start({ provider: 'claude' }, PHONE);
    await flush();
    expect(h.children[0]!.env.PATH?.startsWith('/tmp/shim')).toBe(true);
    h.children[0]!.print('visit: https://claude.com/cai/oauth/authorize?code=true\n');
    await flush();
    expect(h.last()).toMatchObject({ method: 'paste', phase: 'needs-input' });
  });

  it('refuses a page outside the allow-list and falls back to the terminal', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.start({ provider: 'claude' }, PHONE);
    await vi.advanceTimersByTimeAsync(0);
    h.children[0]!.print('visit: https://evil.example/authorize\n');
    expect(h.last().phase).toBe('starting');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.last()).toMatchObject({ method: 'terminal', phase: 'waiting', command: 'claude login' });
    expect(h.children[0]!.killed).toBe(true);
  });

  it('fails with account-mismatch when another account signed in', async () => {
    const emails = ['me@work.com', 'other@home.com'];
    const h = harness({
      readIdentity: async () => ({ available: true, fields: [{ label: 'Email', value: emails.shift() ?? '' }] }),
    });
    const started = await h.manager.start({ provider: 'claude' }, PHONE);
    if (!started.ok) throw new Error('start failed');
    await flush();
    h.children[0]!.print('visit: https://claude.com/cai/oauth/authorize?x=1\n');
    await h.manager.input(started.session.sessionId, { code: 'abc' });
    h.children[0]!.exit(0);
    await flush();
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'account-mismatch' });
    expect(resumedCalls).toHaveLength(0);
    expect(h.deps.confirmConnected).not.toHaveBeenCalled();
  });

  it('fails as rejected when the fresh probe does not answer connected', async () => {
    const h = harness({ confirmConnected: async () => false });
    await h.manager.start({ provider: 'cursor' }, LOCAL);
    h.children[0]!.exit(0);
    await flush();
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'rejected' });
    expect(resumedCalls).toHaveLength(0);
  });
});

describe('codex', () => {
  it('shows the device code remotely', async () => {
    const h = harness({ now: () => 1_000_000 });
    await h.manager.start({ provider: 'codex', profileId: 'work' }, PHONE);
    const child = h.children[0]!;
    expect(child.args).toEqual(['login', '--device-auth']);
    expect(child.env.CODEX_HOME).toBe('/accounts/work');
    child.print('\u001b[1mWelcome\u001b[0m\nFollow these steps:\n1. Open https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345\n');
    expect(h.last()).toMatchObject({
      method: 'device', phase: 'waiting', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345',
      expiresAt: new Date(1_000_000 + 15 * 60_000).toISOString(),
    });
  });

  it('writes a pasted key to stdin only', async () => {
    const h = harness();
    const started = await h.manager.start({ provider: 'codex', method: 'key' }, LOCAL);
    if (!started.ok) throw new Error('start failed');
    expect(started.session).toMatchObject({ method: 'key', phase: 'needs-input' });
    expect(h.children).toHaveLength(0);
    const answered = await h.manager.input(started.session.sessionId, { apiKey: SECRET });
    const child = h.children[0]!;
    expect(child.args).toEqual(['login', '--with-api-key']);
    expect(child.args.join(' ')).not.toContain(SECRET);
    expect(child.writes).toEqual([`${SECRET}\n`]);
    expect(child.stdinClosed).toBe(true);
    child.exit(0);
    await flush();
    expect(h.last().phase).toBe('connected');
    expect(JSON.stringify([h.events, answered])).not.toContain(SECRET);
  });

  it('takes the local authorize URL from stderr', async () => {
    const h = harness();
    await h.manager.start({ provider: 'codex' }, LOCAL);
    await flush();
    h.children[0]!.print('Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app\n');
    expect(h.last()).toMatchObject({ method: 'browser', phase: 'waiting' });
    expect(h.last().url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  });
});

describe('cursor and copilot', () => {
  it('relays cursor\'s polling link with the browser suppressed', async () => {
    const h = harness();
    await h.manager.start({ provider: 'cursor' }, PHONE);
    const child = h.children[0]!;
    expect(child.env.NO_OPEN_BROWSER).toBe('1');
    child.print('Open this link to sign in:\nhttps://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login\n');
    expect(h.last()).toMatchObject({ method: 'link', phase: 'waiting', url: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login' });
  });

  it('parses copilot\'s device flow', async () => {
    const h = harness();
    await h.manager.start({ provider: 'copilot' }, PHONE);
    h.children[0]!.print('To authenticate, visit https://github.com/login/device and enter code 1A2B-3C4D.\n');
    expect(h.last()).toMatchObject({ method: 'device', url: 'https://github.com/login/device', userCode: '1A2B-3C4D' });
  });

  it('falls back to the terminal when copilot exits without a code', async () => {
    const h = harness();
    await h.manager.start({ provider: 'copilot' }, LOCAL);
    h.children[0]!.exit(1);
    await flush();
    expect(h.last()).toMatchObject({ method: 'terminal', phase: 'waiting', command: 'copilot login' });
    expect(h.deps.openTerminal).toHaveBeenCalledWith('copilot login');
    expect(h.deps.watchTerminal).toHaveBeenCalled();
  });

  it('reports a missing CLI as not-installed', async () => {
    const h = harness();
    await h.manager.start({ provider: 'cursor' }, LOCAL);
    h.children[0]!.exit(null, 'ENOENT');
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'not-installed' });
  });
});

describe('opencode', () => {
  function opencodeFetch(calls: Array<{ url: string; method?: string; body?: string }>, authorize: unknown): LoginFetch {
    return async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
      if (url.endsWith('/provider/auth')) return json({ openai: [{ type: 'oauth', label: 'ChatGPT' }, { type: 'api' }], anthropic: [{ type: 'api' }] });
      if (url.endsWith('/oauth/authorize')) return json(authorize);
      if (url.endsWith('/oauth/callback')) return json(true);
      if (init?.method === 'PUT') return json(true);
      return { ok: false, status: 404, json: async () => null };
    };
  }

  it('runs the provider device flow through a private opencode serve', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const h = harness({ fetch: opencodeFetch(calls, { url: 'https://auth.openai.com/codex/device', method: 'auto', instructions: 'Enter code: WXYZ-98765' }) });
    await h.manager.start({ provider: 'opencode' }, PHONE);
    await flush();
    await flush();
    const server = h.children[0]!;
    expect(server.args.slice(0, 3)).toEqual(['serve', '--hostname', '127.0.0.1']);
    expect(server.env.OPENCODE_SERVER_PASSWORD).toBeTruthy();
    await flush();
    expect(h.sessions().some((s) => s.method === 'device' && s.userCode === 'WXYZ-98765')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/provider/openai/oauth/authorize') && c.body === '{"method":0}')).toBe(true);
    await flush();
    expect(h.last().phase).toBe('connected');
    expect(server.killed).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain(server.env.OPENCODE_SERVER_PASSWORD!);
  });

  it('saves a key through PUT /auth/{id} and never echoes it', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const h = harness({ fetch: opencodeFetch(calls, null) });
    const started = await h.manager.start({ provider: 'opencode', method: 'key' }, LOCAL);
    if (!started.ok) throw new Error('start failed');
    await flush();
    await flush();
    expect(h.last()).toMatchObject({ method: 'key', phase: 'needs-input', keyProviders: ['anthropic', 'openai'] });
    expect(await h.manager.input(started.session.sessionId, { apiKey: SECRET, keyProvider: 'nope' })).toMatchObject({ ok: false, status: 400 });
    const answered = await h.manager.input(started.session.sessionId, { apiKey: SECRET, keyProvider: 'anthropic' });
    await flush();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: expect.stringMatching(/\/auth\/anthropic$/) });
    expect(h.last().phase).toBe('connected');
    expect(JSON.stringify([h.events, answered])).not.toContain(SECRET);
  });
});

describe('terminal-only runners', () => {
  it('hands kimi to a watched terminal locally', async () => {
    const h = harness();
    const started = await h.manager.start({ provider: 'kimi' }, LOCAL);
    expect(started).toMatchObject({ ok: true, session: { method: 'terminal', phase: 'waiting', command: 'kimi login' } });
    expect(h.deps.openTerminal).toHaveBeenCalledWith('kimi login');
    expect(h.deps.watchTerminal).toHaveBeenCalledWith('kimi', expect.objectContaining({ id: 'default' }));
    // The watcher sees the account come back.
    await h.manager.accountConnected('kimi', 'default');
    expect(h.last()).toMatchObject({ phase: 'connected' });
    expect(resumedCalls).toHaveLength(1);
  });

  it('never sends a named account\'s folder to a phone', async () => {
    const h = harness();
    const started = await h.manager.start({ provider: 'kimi', profileId: 'work' }, PHONE);
    expect(started).toMatchObject({ ok: true, session: { method: 'terminal' } });
    expect(JSON.stringify([started, h.events])).not.toContain('/accounts/work');
    expect(h.deps.openTerminal).not.toHaveBeenCalled();
  });

  it('does not accept a code', async () => {
    const h = harness();
    const started = await h.manager.start({ provider: 'gemini' }, LOCAL);
    if (!started.ok) throw new Error('start failed');
    expect(await h.manager.input(started.session.sessionId, { code: 'x' })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('lifecycle', () => {
  it('joins a running session for the same account', async () => {
    const h = harness();
    const a = await h.manager.start({ provider: 'cursor' }, LOCAL);
    const b = await h.manager.start({ provider: 'cursor', profileId: 'default' }, LOCAL);
    if (!a.ok || !b.ok) throw new Error('start failed');
    expect(b.session.sessionId).toBe(a.session.sessionId);
    expect(h.children).toHaveLength(1);
  });

  it('cancel kills the process and ends the session', async () => {
    const h = harness();
    const started = await h.manager.start({ provider: 'cursor' }, LOCAL);
    if (!started.ok) throw new Error('start failed');
    const cancelled = await h.manager.cancel(started.session.sessionId);
    expect(cancelled).toMatchObject({ ok: true, session: { phase: 'cancelled' } });
    expect(h.children[0]!.killed).toBe(true);
    h.children[0]!.exit(0);
    await flush();
    expect(h.last().phase).toBe('cancelled');
    expect(resumedCalls).toHaveLength(0);
    expect(await h.manager.cancel('nope')).toMatchObject({ ok: false, status: 404 });
  });

  it('expires after the session lifetime and kills the process', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.start({ provider: 'cursor' }, LOCAL);
    h.children[0]!.print('https://cursor.com/loginDeepControl?challenge=a\n');
    await vi.advanceTimersByTimeAsync(LOGIN_SESSION_TTL_MS);
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'expired' });
    expect(h.children[0]!.killed).toBe(true);
  });

  it('resumes once when several paths see the same login', async () => {
    const h = harness();
    await h.manager.start({ provider: 'cursor' }, LOCAL);
    h.children[0]!.exit(0);
    await flush();
    await h.manager.accountConnected('cursor', 'default');
    await h.manager.accountConnected('cursor', 'default');
    expect(resumedCalls).toHaveLength(1);
    expect(h.events.filter((e) => e.event === 'account-reconnected')).toHaveLength(1);
  });
});

describe('dry run', () => {
  it('mocks a device sign-in without spawning anything', async () => {
    vi.useFakeTimers();
    const h = harness({ dryRun: () => true, dryRunConnectMs: 3_000 });
    const started = await h.manager.start({ provider: 'claude' }, LOCAL);
    expect(started).toMatchObject({ ok: true, session: { method: 'device', phase: 'waiting', userCode: DRY_RUN_USER_CODE } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.last()).toMatchObject({ phase: 'connected' });
    expect(h.children).toHaveLength(0);
    expect(resumedCalls).toHaveLength(1);
  });

  it('accepts a mock key without echoing it', async () => {
    const h = harness({ dryRun: () => true, dryRunConnectMs: 0 });
    const started = await h.manager.start({ provider: 'codex', method: 'key' }, LOCAL);
    if (!started.ok) throw new Error('start failed');
    await h.manager.input(started.session.sessionId, { apiKey: SECRET });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.last().phase).toBe('connected');
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
  });
});

describe('accounts added from the cockpit (spec 2026-11-24-add-account-in-cockpit)', () => {
  it('marks a named account signed in once the sign-in is confirmed, never the default', async () => {
    const markSignedIn = vi.fn(async () => {});
    const h = harness({ markSignedIn });
    await h.manager.start({ provider: 'cursor', profileId: 'work' }, LOCAL);
    expect(h.manager.isLive('cursor', 'work')).toBe(true);
    h.children[0]!.exit(0);
    await flush();
    expect(h.last().phase).toBe('connected');
    expect(markSignedIn).toHaveBeenCalledWith('cursor', 'work');
    expect(h.manager.isLive('cursor', 'work')).toBe(false);

    await h.manager.accountConnected('claude', 'default');
    expect(markSignedIn).toHaveBeenCalledTimes(1);
  });

  it('does not mark an account whose sign-in was rejected', async () => {
    const markSignedIn = vi.fn(async () => {});
    const h = harness({ markSignedIn, confirmConnected: async () => false });
    await h.manager.start({ provider: 'cursor', profileId: 'work' }, LOCAL);
    h.children[0]!.exit(0);
    await flush();
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'rejected' });
    expect(markSignedIn).not.toHaveBeenCalled();
  });

  it('cancelAccount stops a running sign-in and kills its process', async () => {
    const h = harness();
    await h.manager.start({ provider: 'cursor', profileId: 'work' }, LOCAL);
    h.manager.cancelAccount('cursor', 'work');
    expect(h.last().phase).toBe('cancelled');
    expect(h.children[0]!.killed).toBe(true);
  });
});
