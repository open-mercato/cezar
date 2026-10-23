import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAccount, claudeUsageStatus } from './claude-usage-status.ts';

describe('claudeAccount', () => {
  it('reads the org and email of CLAUDE_CONFIG_DIR, else of ~/.claude.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-claude-account-'));
    try {
      const oauthAccount = { organizationName: 'WP-Stars', emailAddress: 'me@example.com', accountUuid: 'x' };
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount }));
      expect(claudeAccount(dir)).toEqual({ org: 'WP-Stars', email: 'me@example.com' });
      expect(claudeAccount(undefined, dir)).toEqual({ org: 'WP-Stars', email: 'me@example.com' });
      writeFileSync(join(dir, '.claude.json'), '{"oauthAccount":{}}');
      expect(claudeAccount(dir)).toBeUndefined();
      writeFileSync(join(dir, '.claude.json'), 'not json');
      expect(claudeAccount(dir)).toBeUndefined();
      expect(claudeAccount(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Shapes captured from a live `claude -p --output-format stream-json --verbose` run (2026-10-23).
describe('claudeUsageStatus', () => {
  it('reads context fill from a main-agent message', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { usage: { input_tokens: 2, cache_creation_input_tokens: 39924, cache_read_input_tokens: 11803, output_tokens: 4 } },
    };
    expect(claudeUsageStatus(msg, undefined)).toEqual({ contextTokens: 51729 });
  });

  it('ignores a sub-agent message: its context is not the session one', () => {
    const msg = { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { usage: { input_tokens: 9 } } };
    expect(claudeUsageStatus(msg, undefined)).toBeUndefined();
  });

  it('takes the context window of the session model from result.modelUsage', () => {
    const msg = {
      type: 'result',
      modelUsage: { 'claude-haiku-5-5': { contextWindow: 200000 }, 'claude-opus-5-5': { contextWindow: 1000000 } },
    };
    expect(claudeUsageStatus(msg, 'claude-opus-5-5')).toEqual({ contextWindow: 1000000 });
    expect(claudeUsageStatus({ type: 'result' }, 'claude-opus-5-5')).toBeUndefined();
  });

  it('reads the plan windows from rate_limit_event', () => {
    const msg = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.19, resetsAt: 1792750200 },
          seven_day: { utilization: 0.2, resetsAt: 1792782000 },
          broken: { utilization: 'x' },
        },
      },
    };
    expect(claudeUsageStatus(msg, undefined)).toEqual({
      limits: [
        { window: 'five_hour', utilization: 0.19, resetsAt: new Date(1792750200_000).toISOString() },
        { window: 'seven_day', utilization: 0.2, resetsAt: new Date(1792782000_000).toISOString() },
      ],
    });
  });

  it('never throws on junk', () => {
    for (const junk of [null, 'x', [], { type: 'assistant' }, { type: 'rate_limit_event', rate_limit_info: 1 }]) {
      expect(claudeUsageStatus(junk, undefined)).toBeUndefined();
    }
  });
});
