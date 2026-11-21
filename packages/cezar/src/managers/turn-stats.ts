import type { PlanUsageTurnStats } from '@open-mercato/cezar-contract';
import type { AgentEvent, AgentUsageStatus } from '../core/agent-runner.ts';

/**
 * What one manager turn is made of (spec 2026-11-21-manager-short-sessions-and-memory § 2.3): the
 * model requests it made, the context each one carried, and whether its tool calls routed work to
 * tasks, looked at cezar state, did work itself, or wrote files for command text.
 */

type ToolKind = keyof PlanUsageTurnStats['tools'];

/** `cez-manager` subcommands that act; every other one only reads. */
const ROUTE = new Set(['merge', 'propose-action', 'rename']);
const ROUTE_TASK = new Set(['create', 'say', 'follow', 'unfollow', 'cancel', 'retry']);
const ROUTE_SUB = new Set(['add', 'remove', 'set', 'enable', 'disable', 'pause']);
/** `cez automation` subcommands that change something; list, show, check and schema only read. */
const ROUTE_AUTOMATION = new Set(['create', 'add', 'update', 'enable', 'pause', 'delete', 'run', 'report', 'unlink']);
/** Flags that take a value, so the value is never read as a subcommand. */
const VALUE_FLAGS = new Set([
  '--project', '--runner', '--account', '--model', '--effort', '--title', '--workflow', '--kind', '--why', '--reason',
  '--name', '--every', '--file', '--from-message', '--since', '--grep', '--limit', '--method', '--connector', '--tool',
  '--args', '--mode', '--report-mode', '--prompt', '--cron', '--at', '--on', '--label', '--author',
]);

/** The words after `cez-manager`, flags and their values skipped: `[subcommand, next]`. */
function managerWords(command: string): string[] | undefined {
  const match = /(?:^|[\s;&|(])cez-manager\s+([^;&|)\n]*)/.exec(command);
  if (!match) return undefined;
  const words: string[] = [];
  const tokens = match[1]!.trim().split(/\s+/);
  for (let i = 0; i < tokens.length && words.length < 2; i++) {
    const token = tokens[i]!;
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) i++;
      continue;
    }
    if (!/^[a-z-]+$/.test(token)) break;
    words.push(token);
  }
  return words;
}

export function managerToolKind(tool: string, input: unknown): ToolKind {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') return 'write';
  const command = tool === 'Bash' && typeof (input as { command?: unknown } | undefined)?.command === 'string'
    ? (input as { command: string }).command
    : '';
  const words = managerWords(command);
  if (!words) return 'own';
  const [sub, next] = words;
  if (!sub) return 'look';
  if (ROUTE.has(sub)) return 'route';
  if (sub === 'automation') return next && ROUTE_AUTOMATION.has(next) ? 'route' : 'look';
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
