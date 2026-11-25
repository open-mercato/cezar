import type { LoginFailureReason, LoginMethod, LoginSession, LoginSessionInput } from '@open-mercato/cezar-contract';
import type { ProviderId } from '../provider-auth.ts';
import type { ResolvedAgentProfile } from '../../workspace/agent-profiles.ts';

/**
 * The seam between the login-session manager and one vendor's sign-in (spec
 * 2026-11-18-inline-account-reconnect). A driver relays what the CLI prints into the session and
 * writes what the user pastes into the CLI's stdin; it never stores either.
 */

/** A spawned sign-in process. Output is decoded text; `kill` takes the whole process tree. */
export interface LoginChild {
  onOutput(listener: (text: string) => void): void;
  /** `error` is a Node errno code (`ENOENT`) when the spawn itself failed. */
  onExit(listener: (code: number | null, error?: string) => void): void;
  write(text: string): void;
  closeStdin(): void;
  kill(): void;
}

export type SpawnLogin = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => LoginChild;

/** `fetch` against the short-lived loopback `opencode serve` only. */
export type LoginFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** What the card may show; the manager owns `sessionId`, `provider`, `profileId` and `resumed`. */
export type LoginSessionPatch = Partial<Pick<LoginSession, 'method' | 'phase' | 'url' | 'userCode' | 'expiresAt' | 'command' | 'keyProviders'>>;

export interface DriverControl {
  provider: ProviderId;
  profile: ResolvedAgentProfile;
  /** No localhost callback reaches this browser: a phone or a hosted cockpit. */
  remote: boolean;
  /** The method the request asked for, when it named one. */
  method?: LoginMethod;
  /** Optional OpenCode auth provider to sign into (`openai`, `github-copilot`, …). */
  authProvider?: string;
  executable: string;
  /** The curated child env for this provider, account variable included. */
  env: NodeJS.ProcessEnv;
  spawn: SpawnLogin;
  fetch: LoginFetch;
  /** Make a PATH shim that records URLs passed to `open`/`xdg-open`; null where none can be made. */
  browserShim(): Promise<BrowserShim | null>;
  now(): number;
  update(patch: LoginSessionPatch): void;
  /** The vendor's sign-in finished on its side; the manager verifies it. */
  succeed(): void;
  fail(reason: LoginFailureReason): void;
  /** No headless path here: hand over to the watched terminal sign-in. */
  fallbackToTerminal(): void;
  /** True once the session ended (cancel, expiry, success or failure). */
  done(): boolean;
}

export interface BrowserShim {
  /** Prepend to PATH. */
  dir: string;
  /** URLs the CLI tried to open, oldest first. */
  urls(): Promise<string[]>;
  dispose(): Promise<void>;
}

export type DriverInputResult = { ok: true } | { ok: false; status: 400 | 409; error: string };

export interface LoginDriver {
  input?(body: LoginSessionInput): Promise<DriverInputResult>;
  /** Kill what the driver started. Idempotent. */
  dispose(): void;
}

export type StartDriver = (ctl: DriverControl) => LoginDriver;
