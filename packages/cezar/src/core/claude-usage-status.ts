/**
 * Claude stream-json frames that feed the run header's live gauges, the same numbers Claude
 * Code's own status line reads: context fill from the latest main-agent message, the window
 * size from `result.modelUsage`, and the plan windows from `rate_limit_event`.
 * Untrusted wire data: never throws, `undefined` when the frame carries nothing.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentUsageStatus, AgentUsageWindow } from './agent-runner.ts';

/** The account a Claude config dir is signed in to (what `claude auth status` reports), read
 *  from its `.claude.json`: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeAccount(configDir: string | undefined, home = homedir()): AgentUsageStatus['account'] {
  try {
    const file = configDir ? join(configDir, '.claude.json') : join(home, '.claude.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const oauth = isRecord(parsed) && isRecord(parsed.oauthAccount) ? parsed.oauthAccount : undefined;
    if (oauth === undefined) return undefined;
    const org = typeof oauth.organizationName === 'string' && oauth.organizationName !== '' ? oauth.organizationName : undefined;
    const email = typeof oauth.emailAddress === 'string' && oauth.emailAddress !== '' ? oauth.emailAddress : undefined;
    if (org === undefined && email === undefined) return undefined;
    return { ...(org !== undefined ? { org } : {}), ...(email !== undefined ? { email } : {}) };
  } catch {
    return undefined;
  }
}

export function claudeUsageStatus(msg: unknown, model: string | undefined): AgentUsageStatus | undefined {
  if (!isRecord(msg)) return undefined;
  if (msg.type === 'assistant' && msg.parent_tool_use_id == null && isRecord(msg.message)) {
    const usage = msg.message.usage;
    if (!isRecord(usage)) return undefined;
    const input = num(usage.input_tokens);
    if (input === undefined) return undefined;
    return {
      contextTokens: input + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0),
    };
  }
  if (msg.type === 'result' && isRecord(msg.modelUsage)) {
    const entries = Object.entries(msg.modelUsage);
    const main = (model !== undefined ? msg.modelUsage[model] : undefined) ?? entries[0]?.[1];
    const contextWindow = isRecord(main) ? num(main.contextWindow) : undefined;
    return contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : undefined;
  }
  if (msg.type === 'rate_limit_event' && isRecord(msg.rate_limit_info) && isRecord(msg.rate_limit_info.unifiedWindows)) {
    const limits: AgentUsageWindow[] = [];
    for (const [window, raw] of Object.entries(msg.rate_limit_info.unifiedWindows)) {
      if (!isRecord(raw)) continue;
      const utilization = num(raw.utilization);
      const resetsAt = num(raw.resetsAt);
      if (utilization === undefined || resetsAt === undefined) continue;
      limits.push({ window, utilization: Math.min(1, Math.max(0, utilization)), resetsAt: new Date(resetsAt * 1000).toISOString() });
    }
    return limits.length > 0 ? { limits } : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
