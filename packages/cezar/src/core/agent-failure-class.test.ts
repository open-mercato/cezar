import { describe, expect, it } from 'vitest';
import {
  accountStateHint,
  classifyAgentFailure,
  MAX_TRANSIENT_RETRIES,
  transientRetryCap,
  transientRetryDelayMs,
} from './agent-failure-class.ts';

describe('classifyAgentFailure — the agent CLIs\' own words (telemetry fingerprints)', () => {
  it.each([
    // transient provider/network
    ['API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com', 'transient'], // 76aa46a9
    ['API Error: No response from API (waited 3m). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS or CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to wait longer.', 'transient'], // 9dd88886
    ['Selected model is at capacity. Please try a different model.', 'transient'], // a1c2fcc2 codex
    ['Error running remote compact task: workspace routing discovery failed', 'transient'], // 5919c71a codex
    ['Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again', 'transient'], // 204c5e03
    ['opencode: Provider is overloaded — retry at 2026-10-26T07:00:00.000Z', 'transient'],
    ['stream disconnected before completion: error sending request', 'transient'], // codex
    ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'transient'],
    ['API Error: 502 Bad Gateway', 'transient'],
    // account state
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'], // 9e4a95db
    ['Not logged in · Please run /login', 'auth'],
    ['Copilot CLI: please run copilot login', 'auth'],
    ['Credit balance is too low', 'billing'], // 7d0a1d6d
    ['You exceeded your current quota, please check your plan and billing details. (insufficient_quota)', 'billing'],
    ["cursor agent exited with code 1 — ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.", 'usage_limit'], // 5432183c
    ['API Error: 503 auth_unavailable: no auth available (last upstream error: rate_limit_error: This request would exceed your account\'s rate limit. Please try again later.)', 'usage_limit'], // 5432183c twin
    ['Claude AI usage limit reached|1760450400', 'usage_limit'],
    // conversation state
    ['Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit. Remove older images or compact the conversation.', 'context_too_large'], // 13023969
    ['Prompt is too long', 'context_too_large'],
    ['codex: ENOSPC: no space left on device, write', 'disk_full'], // 9cdcedc3
    ['Your input exceeds the context window of this model. (context_length_exceeded)', 'context_too_large'],
    // everything else
    ['exit code 1', 'other'],
    ['claude CLI timed out after 30m and was killed', 'other'],
    [undefined, 'other'],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyAgentFailure(message)).toBe(expected);
  });

  it('reads the agent error behind the prefixes run.ts adds', () => {
    expect(classifyAgentFailure('continue failed: API Error: 529 Overloaded')).toBe('transient');
    expect(classifyAgentFailure('step "work" failed: Credit balance is too low')).toBe('billing');
  });

  it('stays narrow: prose that merely mentions an outage is not a transient failure', () => {
    // A false `transient` buys a retry loop against a provider that will refuse again.
    expect(classifyAgentFailure('Error: fix the overloaded constructor in Parser.java')).toBe('other');
    expect(classifyAgentFailure('tests failed: expected status 503, got 200')).toBe('other');
    expect(classifyAgentFailure('the server returned 529 records')).toBe('other');
    expect(classifyAgentFailure('Failed to refresh the dependency lockfile')).toBe('other');
  });
});

describe('transientRetryDelayMs', () => {
  it('backs off 30 s, then 2 m', () => {
    expect(transientRetryDelayMs(1, 'API Error: 529 Overloaded')).toBe(30_000);
    expect(transientRetryDelayMs(2, 'API Error: 529 Overloaded')).toBe(120_000);
    expect(MAX_TRANSIENT_RETRIES).toBe(2);
  });

  it('waits at least the minute the CLI asks for on the OAuth refresh race', () => {
    const race = 'Failed to refresh OAuth token: another Claude Code process is refreshing it';
    expect(transientRetryDelayMs(1, race, () => 0)).toBe(60_000);
    expect(transientRetryDelayMs(2, race, () => 0)).toBe(120_000);
  });

  it('spreads the OAuth refresh race by up to 45 s so runs that lost it together do not retry together (#1480)', () => {
    const race = 'Failed to refresh OAuth token: another Claude Code process is refreshing it';
    expect(transientRetryDelayMs(1, race, () => 0.999999)).toBe(60_000 + 44_999);
    expect(transientRetryDelayMs(1, race, () => 0.5)).toBe(60_000 + 22_500);
    // Other transient failures keep their fixed backoff.
    expect(transientRetryDelayMs(1, 'API Error: 529 Overloaded', () => 0.9)).toBe(30_000);
  });

  it('gives the OAuth refresh race three retries and every other transient failure two (#1480)', () => {
    expect(transientRetryCap('Failed to refresh OAuth token: another Claude Code process is refreshing it')).toBe(3);
    expect(transientRetryCap('API Error: 529 Overloaded')).toBe(2);
  });
});

describe('accountStateHint', () => {
  it('tells the user what to do for every account and conversation state', () => {
    expect(accountStateHint('auth', 'claude')).toMatch(/^Claude Code is not signed in or its login expired — sign in again/);
    expect(accountStateHint('billing', 'claude')).toMatch(/run out of credit/);
    expect(accountStateHint('usage_limit', 'cursor')).toMatch(/^the Cursor account reached its usage limit and did not say when it resets/);
    expect(accountStateHint('context_too_large', 'claude')).toMatch(/start a new task from this one's handoff/);
  });

  it('says nothing where cezar already acts or has nothing to add', () => {
    expect(accountStateHint('usage_limit', 'claude', { resetKnown: true })).toBeUndefined();
    expect(accountStateHint('transient', 'claude')).toBeUndefined();
    expect(accountStateHint('other', 'claude')).toBeUndefined();
  });

  it('names an unknown backend generically', () => {
    expect(accountStateHint('billing', undefined)).toMatch(/^the agent account has run out of credit/);
    expect(accountStateHint('auth', 'mystery')).toMatch(/^The agent is not signed in/);
  });
});
