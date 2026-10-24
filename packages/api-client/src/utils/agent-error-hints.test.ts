import { describe, expect, it } from 'vitest'

import { classifyAgentErrorHint } from './agent-error-hints.ts'

// Verbatim from the telemetry groups named in spec 2026-10-24-agent-cli-error-cooperation.md. The
// thread shows the runner's text without cezar's `<backend>: ` attribution, so both spellings count.
const REAL: Array<[group: string, message: string, expected: ReturnType<typeof classifyAgentErrorHint>]> = [
  ['8e1173b1', "There's an issue with the selected model (openai/gpt-5.1). It may not exist or you may not have access to it. Run --model to pick a different model.", { kind: 'model_unavailable' }],
  ['a1c2fcc2', 'Selected model is at capacity. Please try a different model.', { kind: 'model_unavailable' }],
  ['5432183c', "cursor agent exited with code 1 — ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.", { kind: 'quota_no_reset' }],
  ['7d0a1d6d', 'Credit balance is too low', { kind: 'billing' }],
  ['13023969', 'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit. Remove older images or compact the conversation.', { kind: 'conversation_too_large' }],
  ['9cdcedc3', 'ENOSPC: no space left on device, write', { kind: 'disk_full' }],
  ['75ae746c', 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access', { kind: 'account_policy' }],
  ['c65a5ac5', 'API Error: 400 Identity verification is required to continue.', { kind: 'account_policy', identityVerification: true }],
]

describe('classifyAgentErrorHint', () => {
  it.each(REAL)('classifies telemetry group %s', (_group, message, expected) => {
    expect(classifyAgentErrorHint(message)).toEqual(expected)
    const backend = /cursor/.test(message) ? 'cursor' : 'claude'
    expect(classifyAgentErrorHint(`${backend}: ${message}`)).toEqual(expected)
  })

  it('accepts a typographic apostrophe in the Cursor limit', () => {
    expect(classifyAgentErrorHint('You’ve hit your usage limit Get Cursor Pro for more Agent usage')).toEqual({ kind: 'quota_no_reset' })
  })

  it.each([
    '',
    'Not logged in · Please run /login',
    'API Error: 529 Overloaded',
    'No response from API (waited 3m)',
    'Failed to refresh OAuth token: another Claude Code process is refreshing it',
    // A usage limit WITH a reset instant auto-resumes (spec 2026-08-03) — no hint, no upgrade pitch.
    "You've hit your usage limit · resets 3pm (Europe/Warsaw)",
    'Claude AI usage limit reached|1760000000',
    // The gateway cooldown merged into 5432183c is a proxy rate limit, not a plan without reset.
    'API Error: 503 auth_unavailable: no auth available (providers=claude, model=claude-opus-5-5; last upstream error: rate_limit_error: This request would exceed your account\'s rate limit. Please try again later.)',
    // Agent prose and tool output mentioning the words are not the vendor refusing.
    'add a test for the request too large banner',
    'the model list is at the top of the file',
    'credit balance display is too small on mobile',
    'opencode: Upstream request failed: Invalid credential',
    'OpenCode 1.18.0 or newer is required to use the free tier',
  ])('gives no hint for %j', (message) => {
    expect(classifyAgentErrorHint(message)).toBeNull()
  })
})
