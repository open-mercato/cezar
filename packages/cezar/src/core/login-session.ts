import type { LoginSession, LoginSessionInput, LoginSessionStartInput } from '@open-mercato/cezar-contract';

/**
 * Server-side login sessions for inline account reconnect (spec
 * 2026-11-18-inline-account-reconnect). SKELETON: the routes and the cockpit compile against this
 * shape; the drivers land with the implementation.
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

export class LoginSessionManager {
  async start(_input: LoginSessionStartInput, _ctx: LoginRequestContext): Promise<LoginSessionResult> {
    return { ok: false, status: 409, error: 'Inline sign-in is not available yet.' };
  }

  async input(_sessionId: string, _body: LoginSessionInput): Promise<LoginSessionResult> {
    return { ok: false, status: 404, error: 'unknown login session' };
  }

  async cancel(_sessionId: string): Promise<LoginSessionResult> {
    return { ok: false, status: 404, error: 'unknown login session' };
  }
}
