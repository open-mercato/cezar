import type { Config } from '../config/config.model.js';
import type { AgentBackend, AgentRunner } from './agent-runner.js';
import { AnthropicApiRunner } from './anthropic-api-runner.js';
import { ClaudeCodeCliRunner, type SpawnFn } from './claude-cli-runner.js';
import { CodexCliRunner } from './codex-cli-runner.js';

export interface CreateAgentRunnerOptions {
  /** Reserved for backend selection driven by workspace/repo config (Phase 1+). */
  config?: Config;
  /** Injectable subprocess spawner for the CLI backends (tests). */
  spawnFn?: SpawnFn;
  /** Override the CLI binary name/path (defaults: `claude` / `codex`). */
  bin?: string;
  /** Wall-clock timeout for a CLI run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** $/Mtoken used to derive `claude --max-budget-usd` from `spec.tokenBudget`. */
  usdPerMillionTokens?: number;
}

export const DEFAULT_AGENT_BACKEND: AgentBackend = 'anthropic-api';

/**
 * Pick the `AgentRunner` implementation for a backend. Cloud workers default to
 * `anthropic-api`; self-hosted runners advertise which CLI backends they serve.
 */
export function createAgentRunner(
  backend: AgentBackend = DEFAULT_AGENT_BACKEND,
  opts: CreateAgentRunnerOptions = {},
): AgentRunner {
  // Unified-mode backend lock: unified single-session runs are CLI-only
  // because the Claude Agent SDK doesn't expose stream-json stdin
  // semantics. Reject early with an actionable message rather than failing
  // further down.
  const mode = opts.config?.autofix?.runner?.mode;
  if (mode === 'unified' && backend !== 'claude-cli') {
    throw new Error(
      `autofix.runner.mode='unified' requires backend='claude-cli' but got '${backend}'. ` +
        `Either switch this workspace to the claude-cli backend or set autofix.runner.mode='staged'.`,
    );
  }

  // No default here — let `ClaudeCodeCliRunner.resolveDefaultTransport()`
  // pick `'stream-json'` (with the `CEZAR_CLI_TRANSPORT` env escape hatch).
  // If the workspace config pins one explicitly, that wins.
  const transport = opts.config?.autofix?.runner?.transport;

  switch (backend) {
    case 'anthropic-api':
      return new AnthropicApiRunner();
    case 'claude-cli':
      return new ClaudeCodeCliRunner({
        spawnFn: opts.spawnFn,
        bin: opts.bin,
        timeoutMs: opts.timeoutMs,
        usdPerMillionTokens: opts.usdPerMillionTokens,
        transport,
      });
    case 'codex-cli':
      return new CodexCliRunner({
        spawnFn: opts.spawnFn,
        bin: opts.bin,
        timeoutMs: opts.timeoutMs,
      });
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unknown agent backend: ${String(exhaustive)}`);
    }
  }
}
