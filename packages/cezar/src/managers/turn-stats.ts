import type { PlanUsageTurnStats } from '@open-mercato/cezar-contract';
import type { AgentEvent, AgentUsageStatus } from '../core/agent-runner.ts';
import { isManagerCommand, MANAGER_ROUTES, MANAGER_SUBCOMMANDS } from './cli-vocabulary.ts';

/**
 * What one manager turn is made of (spec 2026-11-21-manager-short-sessions-and-memory § 2.3): the
 * model requests it made, the context each one carried, and whether its tool calls routed work to
 * tasks, looked at cezar state, did work itself, or wrote files for command text.
 */

type ToolKind = keyof PlanUsageTurnStats['tools'];

/**
 * The command and subcommand of a `cez-manager` call: the first word the CLI knows as a command,
 * then the first later word that command knows as a subcommand. Matching the CLI's own words, not a
 * list of flags, keeps a flag's value from being read as the subcommand, unless the value is itself
 * one of those words.
 */
function managerWords(command: string): { sub?: string; next?: string } | undefined {
  const match = /(?:^|[\s;&|(])cez-manager(?:\s+([^;&|)\n]*))?/.exec(command);
  if (!match) return undefined;
  const tokens = (match[1] ?? '').trim().split(/\s+/);
  const at = tokens.findIndex(isManagerCommand);
  if (at < 0) return {};
  const sub = tokens[at]!;
  const known = MANAGER_SUBCOMMANDS[sub as keyof typeof MANAGER_SUBCOMMANDS] ?? [];
  const next = tokens.slice(at + 1).find((token) => known.includes(token));
  return { sub, ...(next ? { next } : {}) };
}

export function managerToolKind(tool: string, input: unknown): ToolKind {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') return 'write';
  const command = tool === 'Bash' && typeof (input as { command?: unknown } | undefined)?.command === 'string'
    ? (input as { command: string }).command
    : '';
  const words = managerWords(command);
  if (!words) return 'own';
  const route = words.sub ? MANAGER_ROUTES[words.sub as keyof typeof MANAGER_ROUTES] : undefined;
  if (route === true) return 'route';
  return route && words.next && route.has(words.next) ? 'route' : 'look';
}

export class TurnStatsCollector {
  private requests = 0;
  private contextFirst = 0;
  private contextPeak = 0;
  private lastContext = 0;
  private toolResultChars = 0;
  private cold: boolean | undefined;
  private tokens: AgentUsageStatus['turnTokens'];
  private readonly tools: PlanUsageTurnStats['tools'] = { route: 0, look: 0, own: 0, write: 0 };

  event(event: AgentEvent): void {
    if (event.type === 'usage-status' && event.status.turnTokens) this.tokens = event.status.turnTokens;
    if (event.type === 'usage-status' && event.status.contextTokens !== undefined) {
      // The runner sends a reading only when it changed: one per model request.
      const context = event.status.contextTokens;
      this.requests++;
      if (this.requests === 1) {
        this.contextFirst = context;
        if (event.status.cacheWriteTokens !== undefined && context > 0) this.cold = event.status.cacheWriteTokens > context / 2;
      }
      this.contextPeak = Math.max(this.contextPeak, context);
      this.lastContext = context;
    } else if (event.type === 'tool-call') {
      this.tools[managerToolKind(event.tool, event.input)]++;
    } else if (event.type === 'tool-result') {
      this.toolResultChars += event.result.length;
    }
  }

  /** The context the session holds after this turn: what the next resumed turn starts from. */
  get context(): number {
    return this.lastContext;
  }

  stats(session: { fresh: boolean; sessionTurn: number; idleMs?: number; session?: string }): Omit<PlanUsageTurnStats, 'usd'> {
    return {
      requests: this.requests,
      contextFirst: this.contextFirst,
      contextPeak: this.contextPeak,
      toolResultChars: this.toolResultChars,
      tools: { ...this.tools },
      fresh: session.fresh,
      sessionTurn: session.sessionTurn,
      ...(session.idleMs !== undefined ? { idleMs: Math.max(0, Math.round(session.idleMs)) } : {}),
      ...(this.tokens ? { cacheReadTokens: this.tokens.cacheReadTokens, cacheWriteTokens: this.tokens.cacheWriteTokens, outputTokens: this.tokens.outputTokens } : {}),
      ...(this.cold !== undefined ? { cold: this.cold } : {}),
      ...(session.session ? { session: session.session } : {}),
    };
  }
}
