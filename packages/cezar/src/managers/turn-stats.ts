import type { PlanUsageTurnStats } from '@open-mercato/cezar-contract';
import type { AgentEvent } from '../core/agent-runner.ts';

/**
 * What one manager turn is made of (spec 2026-11-21-manager-short-sessions-and-memory § 2.3): the
 * model requests it made, the context each one carried, and whether its tool calls routed work to
 * tasks, looked at cezar state, did work itself, or wrote files for command text.
 */

type ToolKind = keyof PlanUsageTurnStats['tools'];

/** `cez-manager` subcommands that act; every other one only reads. */
const ROUTE = new Set(['merge', 'propose-action', 'automation', 'rename']);
const ROUTE_TASK = new Set(['create', 'say', 'follow', 'unfollow', 'cancel', 'retry']);
const ROUTE_SUB = new Set(['add', 'remove', 'set', 'enable', 'disable', 'pause']);

export function managerToolKind(tool: string, input: unknown): ToolKind {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') return 'write';
  const command = tool === 'Bash' && typeof (input as { command?: unknown } | undefined)?.command === 'string'
    ? (input as { command: string }).command
    : '';
  const match = /(?:^|[\s;&|(])cez-manager\s+([a-z-]+)(?:\s+([a-z-]+))?/.exec(command);
  if (!match) return 'own';
  const [, sub, next] = match;
  if (ROUTE.has(sub!)) return 'route';
  if (sub === 'task') return next && ROUTE_TASK.has(next) ? 'route' : 'look';
  if (sub === 'job' || sub === 'memory') return next && ROUTE_SUB.has(next) ? 'route' : 'look';
  return 'look';
}

export class TurnStatsCollector {
  private requests = 0;
  private contextFirst = 0;
  private contextPeak = 0;
  private lastContext = 0;
  private toolResultChars = 0;
  private readonly tools: PlanUsageTurnStats['tools'] = { route: 0, look: 0, own: 0, write: 0 };

  event(event: AgentEvent): void {
    if (event.type === 'usage-status' && event.status.contextTokens !== undefined) {
      // The runner sends a reading only when it changed: one per model request.
      const context = event.status.contextTokens;
      this.requests++;
      if (this.requests === 1) this.contextFirst = context;
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

  stats(session: { fresh: boolean; sessionTurn: number; idleMs?: number }): Omit<PlanUsageTurnStats, 'usd'> {
    return {
      requests: this.requests,
      contextFirst: this.contextFirst,
      contextPeak: this.contextPeak,
      toolResultChars: this.toolResultChars,
      tools: { ...this.tools },
      fresh: session.fresh,
      sessionTurn: session.sessionTurn,
      ...(session.idleMs !== undefined ? { idleMs: Math.max(0, Math.round(session.idleMs)) } : {}),
    };
  }
}
