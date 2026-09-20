import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { GeminiAcpRunner } from './gemini-acp-runner.ts';
import { PiRunner } from './pi-runner.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 */
export function createRunner(backend: AgentBackend): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'pi':
      return new PiRunner();
    case 'gemini':
      return new GeminiAcpRunner();
    case 'claude':
    case 'claude-cli':
      return new ClaudeCliRunner();
    default: {
      const unreachable: never = backend;
      throw new Error(`Unknown runner: ${String(unreachable)}`);
    }
  }
}
