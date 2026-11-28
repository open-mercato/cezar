import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  LoginFailureReason,
  LoginSession,
  LoginSessionInput,
  LoginSessionStartInput,
  ReconnectResumed,
} from '@open-mercato/cezar-contract';
import { readsAccountIdentity, type AccountIdentity } from '../agent-config/account-identity.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { emitAccountReconnected } from './account-reconnected.ts';
import { buildChildEnv } from './agent-env.ts';
import { profileEnv } from './agent-profiles.ts';
import { startClaudeLogin } from './login-drivers/claude.ts';
import { startCodexLogin } from './login-drivers/codex.ts';
import { startCopilotLogin, startCursorLogin } from './login-drivers/cursor-copilot.ts';
import { startOpenCodeLogin } from './login-drivers/opencode.ts';
import { createBrowserShim, defaultLoginFetch, loginExecutable, spawnLoginProcess } from './login-drivers/process.ts';
import type {
  BrowserShim,
  DriverControl,
  LoginDriver,
  LoginFetch,
  LoginSessionPatch,
  SpawnLogin,
  StartDriver,
} from './login-drivers/types.ts';
import type { ProviderId } from './provider-auth.ts';

/**
 * Server-side login sessions for inline account reconnect (spec
 * 2026-11-18-inline-account-reconnect): one per `(provider, profileId)`, relaying the vendor's own
 * sign-in to the card. A pasted code or key goes to the CLI's stdin (or OpenCode's API) and is
 * never stored, emitted or logged.
 */
export type LoginSessionResult =
  | { ok: true; session: LoginSession }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string; command?: string };

/** Who is asking: decides the hosted gate and the best method (no localhost callback when remote). */
export interface LoginRequestContext {
  /** The cockpit runs on this machine (`capabilities().localHandoff`). */
  local: boolean;
  /** The request came through a paired phone (relay). */
  phone: boolean;
}

export interface LoginSessionDeps {
  resolveProfile(provider: ProviderId, profileId?: string): Promise<{ profile: ResolvedAgentProfile } | { error: string }>;
  /** `providerAuth.loginCommand`: the terminal fallback, or null when the folder cannot be quoted. */
  loginCommand(provider: ProviderId, configDir: string | null): string | null;
  /** Lift the account's runtime incident, probe it fresh, publish the row; true when connected. */
  confirmConnected(provider: ProviderId, profile: ResolvedAgentProfile): Promise<boolean>;
  /** `CEZ_REMOTE_AGENT_ACCOUNTS=1` on a hosted cockpit. */
  remoteAccountsEnabled(): boolean;
  emit(event: 'agent-login' | 'account-reconnected', payload: unknown): void;
  /** A confirmed sign-in makes an account added from the cockpit usable (spec 2026-11-24). */
  markSignedIn?(provider: ProviderId, profileId: string): Promise<void>;
  /** Connect's terminal hand-off (local only). */
  openTerminal?(command: string): Promise<boolean>;
  /** Connect's login watcher; it reports back through {@link LoginSessionManager.accountConnected}. */
  watchTerminal?(provider: ProviderId, profile: ResolvedAgentProfile): void;
  readIdentity?(provider: ProviderId, configDir: string): Promise<AccountIdentity>;
  dryRun?: () => boolean;
  /** Dry-run mock: how long until the mock sign-in connects. */
  dryRunConnectMs?: number;
  spawn?: SpawnLogin;
  fetch?: LoginFetch;
  browserShim?: () => Promise<BrowserShim | null>;
  drivers?: Partial<Record<ProviderId, StartDriver>>;
  now?: () => number;
  createId?: () => string;
  ensureDir?: (path: string) => Promise<void>;
}

/** No vendor expiry known: a session lives as long as Connect's login watch. */
export const LOGIN_SESSION_TTL_MS = 15 * 60_000;
/** An ended session stays readable this long, so a late input or cancel gets its final state. */
const ENDED_RETENTION_MS = 10 * 60_000;
/** Two paths seeing the same login within this window resume once (session + watcher + Check again). */
const RECONNECT_COALESCE_MS = 60_000;
export const DRY_RUN_USER_CODE = 'DRYR-UN00';

const KEY_PROVIDERS = new Set<ProviderId>(['codex', 'opencode']);
const ENDED = new Set<LoginSession['phase']>(['connected', 'failed', 'cancelled']);

const DEFAULT_DRIVERS: Partial<Record<ProviderId, StartDriver>> = {
  claude: startClaudeLogin,
  codex: startCodexLogin,
  cursor: startCursorLogin,
  copilot: startCopilotLogin,
  opencode: startOpenCodeLogin,
};

const HOSTED_REFUSAL = 'Run this command on the machine hosting cezar.';
const HOSTED_ACCOUNT_REFUSAL =
  'agent accounts are disabled in hosted mode; set CEZ_REMOTE_AGENT_ACCOUNTS=1 only behind an authenticated perimeter';
const KEY_REFUSAL = 'API keys are accepted only for Codex and OpenCode.';

interface Entry {
  key: string;
  session: LoginSession;
  profile: ResolvedAgentProfile;
  ctx: LoginRequestContext;
  driver?: LoginDriver;
  /** The driver's part is over (success reported, failed, cancelled, expired). */
  settled: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  previousEmail?: Promise<string | undefined>;
}

const liveManagers = new Set<LoginSessionManager>();
let exitHookInstalled = false;

function emailOf(identity: AccountIdentity | undefined): string | undefined {
  if (!identity?.available) return undefined;
  return identity.fields.find((field) => field.label === 'Email')?.value.trim().toLowerCase();
}

/** A session as a paired phone may see it: a named account's command carries its folder path. */
export function phoneSafeSession(session: LoginSession): LoginSession {
  if (session.profileId === 'default' || session.command === undefined) return session;
  const { command: _command, ...rest } = session;
  return rest;
}

export class LoginSessionManager {
  private readonly sessions = new Map<string, Entry>();
  private readonly byAccount = new Map<string, Entry>();
  private readonly reconnects = new Map<string, { at: number; resumed: Promise<ReconnectResumed> }>();
  private readonly now: () => number;

  constructor(private readonly deps: LoginSessionDeps) {
    this.now = deps.now ?? Date.now;
  }

  async start(input: LoginSessionStartInput, ctx: LoginRequestContext): Promise<LoginSessionResult> {
    const { provider } = input;
    const named = input.profileId !== undefined && input.profileId !== 'default';
    if (!ctx.local && !ctx.phone && !this.deps.remoteAccountsEnabled()) {
      // Mirrors Connect: a named account is refused before resolution (no path, no id oracle).
      if (named) return { ok: false, status: 409, error: HOSTED_ACCOUNT_REFUSAL };
      const command = this.deps.loginCommand(provider, null);
      return { ok: false, status: 409, error: HOSTED_REFUSAL, ...(command ? { command } : {}) };
    }
    if (input.method === 'key' && !KEY_PROVIDERS.has(provider)) return { ok: false, status: 400, error: KEY_REFUSAL };
    if (input.authProvider !== undefined && provider !== 'opencode') {
      return { ok: false, status: 400, error: 'authProvider applies to OpenCode only.' };
    }
    const resolved = await this.deps.resolveProfile(provider, input.profileId);
    if ('error' in resolved) return { ok: false, status: 400, error: resolved.error };
    const { profile } = resolved;
    const key = `${provider}\u0000${profile.id}`;

    const running = this.byAccount.get(key);
    if (running && !ENDED.has(running.session.phase)) return { ok: true, session: this.view(running) };

    const remote = !ctx.local;
    const entry: Entry = {
      key,
      profile,
      ctx,
      settled: false,
      session: {
        sessionId: (this.deps.createId ?? randomUUID)(),
        provider,
        profileId: profile.id,
        method: input.method ?? (remote ? 'device' : 'browser'),
        phase: 'starting',
      },
    };
    this.sessions.set(entry.session.sessionId, entry);
    this.byAccount.set(key, entry);
    this.armExpiry(entry, this.now() + LOGIN_SESSION_TTL_MS);
    this.publish(entry);

    if (this.deps.dryRun?.()) {
      this.startDryRun(entry, input.method === 'key');
      return { ok: true, session: this.view(entry) };
    }

    // Codex refuses a missing CODEX_HOME (#1918); Connect creates it the same way.
    if (!profile.isDefault) {
      try {
        await (this.deps.ensureDir ?? ((path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => {})))(profile.path);
      } catch {
        this.finish(entry, 'failed', 'unavailable');
        return { ok: true, session: this.view(entry) };
      }
    }
    if (this.deps.readIdentity && readsAccountIdentity(provider)) {
      const read = this.deps.readIdentity;
      entry.previousEmail = read(provider, profile.path).then(emailOf, () => undefined);
    }

    const startDriver = (this.deps.drivers ?? DEFAULT_DRIVERS)[provider];
    if (!startDriver) {
      this.fallbackToTerminal(entry);
      return { ok: true, session: this.view(entry) };
    }
    this.ensureExitHook();
    entry.driver = startDriver(this.control(entry, input, remote));
    return { ok: true, session: this.view(entry) };
  }

  async input(sessionId: string, body: LoginSessionInput): Promise<LoginSessionResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, status: 404, error: 'unknown login session' };
    if ('apiKey' in body && !KEY_PROVIDERS.has(entry.session.provider)) return { ok: false, status: 400, error: KEY_REFUSAL };
    if (entry.settled || ENDED.has(entry.session.phase)) return { ok: false, status: 409, error: 'This sign-in has ended.' };
    if (this.deps.dryRun?.()) {
      if (entry.session.phase !== 'needs-input') return { ok: false, status: 409, error: 'This sign-in is not waiting for input.' };
      this.patch(entry, { phase: 'verifying' });
      this.later(this.deps.dryRunConnectMs ?? 3_000, () => void this.connect(entry, { verify: false }));
      return { ok: true, session: this.view(entry) };
    }
    if (!entry.driver?.input) return { ok: false, status: 409, error: 'This sign-in does not take input.' };
    const result = await entry.driver.input(body);
    if (!result.ok) return { ok: false, status: result.status, error: result.error };
    return { ok: true, session: this.view(entry) };
  }

  async cancel(sessionId: string): Promise<LoginSessionResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, status: 404, error: 'unknown login session' };
    if (!ENDED.has(entry.session.phase)) this.finish(entry, 'cancelled');
    return { ok: true, session: this.view(entry) };
  }

  /**
   * An account came back connected by any path — a login session, Connect's watcher, Check
   * again — so resume what was blocked on it. Coalesced, so one login resumes once however many
   * paths observe it; an open session for the account is marked connected.
   */
  async accountConnected(provider: ProviderId, profileId: string): Promise<ReconnectResumed> {
    await this.markSignedIn(provider, profileId);
    const resumed = await this.reconnected(provider, profileId);
    const entry = this.byAccount.get(`${provider}\u0000${profileId}`);
    if (entry && !ENDED.has(entry.session.phase) && entry.session.phase !== 'verifying') {
      this.finish(entry, 'connected', undefined, resumed);
    }
    return resumed;
  }

  /** Kill every live sign-in (server shutdown). */
  dispose(): void {
    liveManagers.delete(this);
    for (const entry of this.sessions.values()) {
      if (!ENDED.has(entry.session.phase)) this.finish(entry, 'cancelled');
    }
  }

  // ---- internals ------------------------------------------------------------

  /** Sign-ins run in their own process groups, so nothing else takes them down with cezar. */
  private ensureExitHook(): void {
    liveManagers.add(this);
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const manager of liveManagers) manager.dispose();
    });
  }

  private control(entry: Entry, input: LoginSessionStartInput, remote: boolean): DriverControl {
    const { provider } = entry.session;
    const accountEnv = entry.profile.isDefault ? {} : profileEnv(provider, entry.profile.path);
    return {
      provider,
      profile: entry.profile,
      remote,
      ...(input.method ? { method: input.method } : {}),
      ...(input.authProvider ? { authProvider: input.authProvider } : {}),
      executable: loginExecutable(provider),
      env: buildChildEnv({ backend: provider, extraEnv: accountEnv }),
      spawn: this.deps.spawn ?? spawnLoginProcess,
      fetch: this.deps.fetch ?? defaultLoginFetch,
      browserShim: this.deps.browserShim ?? createBrowserShim,
      now: this.now,
      update: (patch) => {
        if (!entry.settled) this.patch(entry, patch);
      },
      succeed: () => {
        if (!entry.settled) void this.connect(entry, { verify: true });
      },
      fail: (reason) => {
        if (!entry.settled) this.finish(entry, 'failed', reason);
      },
      fallbackToTerminal: () => {
        if (!entry.settled) this.fallbackToTerminal(entry);
      },
      done: () => entry.settled,
    };
  }

  private startDryRun(entry: Entry, key: boolean): void {
    if (key) {
      this.patch(entry, { method: 'key', phase: 'needs-input' });
      return;
    }
    this.patch(entry, {
      method: 'device',
      phase: 'waiting',
      userCode: DRY_RUN_USER_CODE,
      expiresAt: new Date(this.now() + LOGIN_SESSION_TTL_MS).toISOString(),
    });
    this.later(this.deps.dryRunConnectMs ?? 3_000, () => void this.connect(entry, { verify: false }));
  }

  private fallbackToTerminal(entry: Entry): void {
    entry.driver?.dispose();
    entry.driver = undefined;
    const { provider } = entry.session;
    const command = this.deps.loginCommand(provider, entry.profile.isDefault ? null : entry.profile.path);
    if (command === null) {
      this.finish(entry, 'failed', 'unavailable');
      return;
    }
    // A phone never receives an account's folder path (it is in a named account's command).
    const shown = entry.ctx.phone && !entry.profile.isDefault ? undefined : command;
    const { url: _url, userCode: _code, keyProviders: _keys, ...rest } = entry.session;
    entry.session = { ...rest, method: 'terminal', phase: 'waiting', ...(shown ? { command: shown } : {}) };
    this.publish(entry);
    if (entry.ctx.local) void this.deps.openTerminal?.(command).catch(() => false);
    this.deps.watchTerminal?.(provider, entry.profile);
  }

  /** The vendor finished: verify identity and status, then resume what was blocked. */
  private async connect(entry: Entry, options: { verify: boolean }): Promise<void> {
    if (entry.settled) return;
    entry.settled = true;
    entry.driver?.dispose();
    entry.driver = undefined;
    this.patch(entry, { phase: 'verifying' });
    const { provider } = entry.session;
    if (options.verify) {
      if (entry.previousEmail && this.deps.readIdentity) {
        const before = await entry.previousEmail;
        const after = await this.deps.readIdentity(provider, entry.profile.path).then(emailOf, () => undefined);
        if (before && after && before !== after) {
          this.finish(entry, 'failed', 'account-mismatch');
          return;
        }
      }
      const connected = await this.deps.confirmConnected(provider, entry.profile).catch(() => false);
      if (ENDED.has(entry.session.phase)) return;
      if (!connected) {
        this.finish(entry, 'failed', 'rejected');
        return;
      }
    }
    await this.markSignedIn(provider, entry.profile.id);
    const resumed = await this.reconnected(provider, entry.profile.id);
    if (ENDED.has(entry.session.phase)) return;
    this.finish(entry, 'connected', undefined, resumed);
  }

  private async markSignedIn(provider: ProviderId, profileId: string): Promise<void> {
    if (profileId === 'default' || !this.deps.markSignedIn) return;
    await this.deps.markSignedIn(provider, profileId).catch(() => {});
  }

  /** Stop a running sign-in for an account that is being removed. */
  cancelAccount(provider: ProviderId, profileId: string): void {
    const entry = this.byAccount.get(`${provider}\u0000${profileId}`);
    if (entry && !ENDED.has(entry.session.phase)) this.finish(entry, 'cancelled');
  }

  /** True while a sign-in for this account is still running (the pending-account sweep keeps it). */
  isLive(provider: ProviderId, profileId: string): boolean {
    const entry = this.byAccount.get(`${provider}\u0000${profileId}`);
    return entry !== undefined && !ENDED.has(entry.session.phase);
  }

  private reconnected(provider: ProviderId, profileId: string): Promise<ReconnectResumed> {
    const key = `${provider}\u0000${profileId}`;
    const recent = this.reconnects.get(key);
    if (recent && this.now() - recent.at < RECONNECT_COALESCE_MS) return recent.resumed;
    const resumed = emitAccountReconnected({ provider, profileId }).then((result) => {
      this.deps.emit('account-reconnected', { provider, profileId, resumed: result });
      return result;
    });
    this.reconnects.set(key, { at: this.now(), resumed });
    return resumed;
  }

  private finish(entry: Entry, phase: 'connected' | 'failed' | 'cancelled', reason?: LoginFailureReason, resumed?: ReconnectResumed): void {
    entry.settled = true;
    entry.driver?.dispose();
    entry.driver = undefined;
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.session = {
      ...entry.session,
      phase,
      ...(reason ? { reason } : {}),
      ...(resumed ? { resumed } : {}),
    };
    this.publish(entry);
    this.later(ENDED_RETENTION_MS, () => {
      this.sessions.delete(entry.session.sessionId);
      if (this.byAccount.get(entry.key) === entry) this.byAccount.delete(entry.key);
    });
  }

  private patch(entry: Entry, patch: LoginSessionPatch): void {
    if (ENDED.has(entry.session.phase)) return;
    entry.session = { ...entry.session, ...patch };
    if (patch.expiresAt) {
      const at = Date.parse(patch.expiresAt);
      if (Number.isFinite(at)) this.armExpiry(entry, at);
    }
    this.publish(entry);
  }

  private armExpiry(entry: Entry, at: number): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = setTimeout(() => {
      if (!ENDED.has(entry.session.phase)) this.finish(entry, 'failed', 'expired');
    }, Math.max(0, at - this.now()));
    entry.expiry.unref?.();
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
  }

  private publish(entry: Entry): void {
    this.deps.emit('agent-login', this.view(entry));
  }

  private view(entry: Entry): LoginSession {
    return { ...entry.session };
  }
}
