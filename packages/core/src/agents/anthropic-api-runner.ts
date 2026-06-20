import {
  query,
  type SDKMessage,
  type QueryOptions,
  type QueryResult,
} from '@anthropic-ai/claude-agent-sdk';
import { TokenBudgetExceededError } from '../actions/autofix/token-budget.js';
import {
  type AgentRunner,
  type AgentRunSpec,
  type AgentRunResult,
  type AgentEvent,
  type AgentToolCallRecord,
  extractBashCommand,
  isBashCommandAllowed,
} from './agent-runner.js';
import { costWeightedTokens, parseStructured, type RawUsage } from './structured-output.js';

/**
 * Stray `ERR_STREAM_WRITE_AFTER_END` errors are emitted as Node
 * `uncaughtException`s on the SDK subprocess's stdin socket (e.g. after the
 * agent terminated and we — or the SDK — write once more). They are benign and
 * would otherwise crash the whole process before an in-flight `run()` can
 * return gracefully. We install a single, refcounted, process-level handler
 * that swallows *only* this specific error and lets every other uncaught
 * exception fall through to Node's default crash path (so the job-claim layer
 * can re-queue the job).
 *
 * The handler is a module-level singleton with an install refcount so that
 * concurrent `run()` calls in one process (cron dispatch / runner daemon)
 * install it exactly once. Previously each `run()` installed its own
 * process-global handler, so a single fatal error fired (and rethrew from)
 * every installed copy, and a `run()` that threw before its cleanup leaked a
 * handler — the refcount fixes both.
 */
let streamWriteGuardRefcount = 0;
function streamWriteAfterEndGuard(err: Error): void {
  if (err && (err as NodeJS.ErrnoException).code === 'ERR_STREAM_WRITE_AFTER_END') return;
  // Not the benign transport error. Re-throwing inside an `uncaughtException`
  // handler escalates to Node's default fatal-crash path — which is what we
  // want: a genuinely uncaught fatal error should terminate the worker so the
  // job-claim layer re-queues the job, rather than being silently swallowed.
  throw err;
}
function armStreamWriteGuard(): void {
  if (streamWriteGuardRefcount++ === 0) {
    process.on('uncaughtException', streamWriteAfterEndGuard);
  }
}
function disarmStreamWriteGuard(): void {
  if (streamWriteGuardRefcount > 0 && --streamWriteGuardRefcount === 0) {
    process.removeListener('uncaughtException', streamWriteAfterEndGuard);
  }
}

/**
 * `AgentRunner` over `@anthropic-ai/claude-agent-sdk`. This is the verbatim
 * extraction of the old `actions/autofix/agent-session.ts` loop — same tool +
 * bash allowlist enforcement, same cache-weighted token-budget accounting,
 * same `ERR_STREAM_WRITE_AFTER_END` guard, same interrupt-on-budget-exceeded.
 * Behavior must not change: the autofix tests pin it byte-for-byte via the
 * `agent-session.ts` shim.
 */
export class AnthropicApiRunner implements AgentRunner {
  readonly backend = 'anthropic-api' as const;

  private activeIter: QueryResult | null = null;

  async run<T = unknown>(
    spec: AgentRunSpec<T>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult<T>> {
    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let tokensUsed = 0;
    let budgetExceeded = false;

    const canUseTool: QueryOptions['canUseTool'] = async (toolName, input) => {
      if (!spec.allowedTools.includes(toolName)) {
        return { behavior: 'deny', message: `Tool '${toolName}' is not on the allowlist` };
      }
      if (toolName === 'Bash' && spec.bashAllowlist) {
        const cmd = extractBashCommand(input);
        if (!cmd || !isBashCommandAllowed(cmd, spec.bashAllowlist)) {
          return {
            behavior: 'deny',
            message:
              `Bash command '${cmd ?? '(missing)'}' is not on the allowlist. ` +
              `Allowed: ${spec.bashAllowlist.join(', ')}`,
          };
        }
      }
      return { behavior: 'allow' };
    };

    // Prompt caching: `@anthropic-ai/claude-agent-sdk` auto-applies
    // `cache_control` on the system prompt + tools when calling Anthropic
    // (see node_modules/@anthropic-ai/claude-agent-sdk/cli.js — grep
    // `cache_control`). The `Options` type doesn't expose a knob for it,
    // so the right way to maximise cache hit rate is to keep `systemPrompt`
    // **static** across runs — put any per-issue/per-repo variation in
    // `userPrompt` instead. AGENT_EXECUTION_GUIDANCE in
    // actions/autofix/prompts/agent-guidance.ts is deliberately shared
    // across all four autofix agents for this reason.
    const queryOpts: QueryOptions = {
      cwd: spec.cwd,
      systemPrompt: spec.systemPrompt,
      allowedTools: spec.allowedTools,
      additionalDirectories: spec.additionalDirectories,
      maxTurns: spec.maxTurns ?? 40,
      permissionMode: 'default',
      canUseTool,
    };
    if (spec.model) queryOpts.model = spec.model;

    const iter = query({ prompt: spec.userPrompt, options: queryOpts });
    this.activeIter = iter;

    // Guard against stray transport errors from the SDK's subprocess (e.g.
    // ERR_STREAM_WRITE_AFTER_END after the agent terminated) — those are
    // emitted as Node 'uncaughtException's on the underlying socket and would
    // otherwise crash the whole process before we could return gracefully.
    // Refcounted so concurrent run()s in one process install it exactly once.
    let sawTerminalMessage = false;
    armStreamWriteGuard();

    try {
      for await (const msg of iter) {
        processMessage(msg, { toolCalls, textChunks, onEvent });
        if ((msg as { type?: string }).type === 'result') {
          sawTerminalMessage = true;
        }

        const delta = extractUsage(msg);
        if (delta > 0) {
          tokensUsed += delta;
          if (spec.tokenBudget) {
            spec.tokenBudget.record({ inputTokens: delta });
            onEvent?.({ type: 'token-usage', tokensUsed });
            try {
              spec.tokenBudget.assertWithinBudget();
            } catch (err) {
              if (err instanceof TokenBudgetExceededError) {
                budgetExceeded = true;
                onEvent?.({
                  type: 'note',
                  message: `token budget exceeded: used ${err.used} of ${err.limit}`,
                });
                // Only call interrupt() if the stream hasn't already finished.
                // Interrupt writes to the subprocess stdin; doing so after the
                // terminal 'result' message causes ERR_STREAM_WRITE_AFTER_END.
                if (!sawTerminalMessage) {
                  try {
                    await iter.interrupt();
                  } catch {
                    /* SDK already closed */
                  }
                }
                break;
              }
              throw err;
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof TokenBudgetExceededError) {
        budgetExceeded = true;
      } else {
        onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        // `finally` below disarms the guard and clears activeIter.
        throw err;
      }
    } finally {
      disarmStreamWriteGuard();
      this.activeIter = null;
    }

    onEvent?.({ type: 'done' });

    const text = textChunks.join('\n').trim();
    const parsed = spec.responseSchema ? parseStructured(text, spec.responseSchema) : null;

    return { text, parsed, toolCalls, tokensUsed, budgetExceeded };
  }

  async interrupt(): Promise<void> {
    if (!this.activeIter) return;
    try {
      await this.activeIter.interrupt();
    } catch {
      /* already closed */
    }
  }
}

function processMessage(
  msg: SDKMessage,
  ctx: {
    toolCalls: AgentToolCallRecord[];
    textChunks: string[];
    onEvent?: (e: AgentEvent) => void;
  },
): void {
  const m = msg as { type: string; message?: { content?: unknown[]; role?: string } };
  if (!m.message?.content) return;

  for (const block of m.message.content) {
    const b = block as {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };

    if (m.type === 'assistant' && b.type === 'text' && typeof b.text === 'string') {
      ctx.textChunks.push(b.text);
      ctx.onEvent?.({ type: 'text', text: b.text });
    } else if (m.type === 'assistant' && b.type === 'tool_use' && b.id && b.name) {
      ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
      ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      ctx.onEvent?.({
        type: 'tool-result',
        toolCallId: b.tool_use_id,
        result: stringifyToolResult(b.content),
        isError: b.is_error === true,
      });
    }
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = c as { type?: string; text?: string };
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractUsage(msg: SDKMessage): number {
  const m = msg as { message?: { usage?: RawUsage }; usage?: RawUsage };
  return costWeightedTokens(m.message?.usage ?? m.usage);
}
