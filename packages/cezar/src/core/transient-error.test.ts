import { describe, expect, it } from 'vitest';
import { isTransientAgentError } from './transient-error.ts';

describe('isTransientAgentError (spec 2026-10-24-agent-cli-error-cooperation § Transient)', () => {
  it.each([
    // The real telemetry messages (76aa46a9, 9dd88886, a1c2fcc2, 204c5e03).
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'continue failed: API Error: 529 Overloaded',
    'step "work" failed: No response from API (waited 3m)',
    'codex: Selected model is at capacity. Please try a different model.',
    'Failed to refresh OAuth token: another Claude Code process is refreshing it. Try again in a moment.',
    'API Error: 500 Internal server error. This is a server-side issue, usually temporary.',
    'opencode: 502 Bad Gateway',
    'request to https://api.anthropic.com failed, reason: read ECONNRESET',
    'connect ETIMEDOUT 160.79.104.10:443',
  ])('%s → transient', (message) => {
    expect(isTransientAgentError(message)).toBe(true);
  });

  it.each([
    // Definitive, auth, billing and quota failures never retry on their own.
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'API Error: 400 Identity verification is required to continue.',
    'Your organization has disabled Claude subscription access for Claude Code',
    'Credit balance is too low',
    'Claude AI usage limit reached|1760450400',
    "cursor: You've hit your usage limit Get Cursor Pro for more agent usage",
    'API Error: 503 auth_unavailable rate_limit_error: usage limit, try again in 5 minutes',
    'insufficient_quota: You exceeded your current quota, server-side issue',
    // Cezar's own run errors, even when they quote a network code.
    'interrupted — cezar process exited during the run',
    'worktree creation failed: git fetch: connect ETIMEDOUT',
    'continue crashed: ECONNRESET',
    'check "test" failed',
    'claude CLI timed out after 30m and was killed',
    'Request too large (max 32MB).',
    'exit code 1',
    '',
    undefined,
  ])('%s → not transient', (message) => {
    expect(isTransientAgentError(message)).toBe(false);
  });
});
