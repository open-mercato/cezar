import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.js';
import { ClaudeCliRunner } from './claude-cli-runner.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';
import { OpencodeServerRunner } from './opencode-server-runner.js';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 */
export function createRunner(backend: AgentBackend | RunnerId | undefined): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner();
  }
}
