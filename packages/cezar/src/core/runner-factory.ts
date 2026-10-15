import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { JunieRunner } from './junie-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { KimiRunner } from './kimi-runner.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 *
 * `launcher` is the orthogonal axis — WHERE the agent runs (this machine, or a
 * sandbox). It is threaded in rather than read from config here so the factory
 * stays pure and the caller owns the config read. Every backend honours it:
 * three speak stdio and only needed the spawn swapped, while opencode talks
 * HTTP to its own process and additionally binds the port the launcher
 * published.
 */
export function createRunner(
  backend: AgentBackend | RunnerId | undefined,
  opts: { launcher?: ProcessLauncher } = {},
): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner({ launcher: opts.launcher });
    case 'opencode':
      return new OpencodeServerRunner({ launcher: opts.launcher });
    case 'cursor':
      return new CursorAgentRunner({ launcher: opts.launcher });
    case 'pi':
      return new PiRunner({ launcher: opts.launcher });
    case 'junie':
      return new JunieRunner({ launcher: opts.launcher });
    case 'copilot':
      return new CopilotAcpRunner({ launcher: opts.launcher });
    case 'kimi':
      return new KimiRunner({ launcher: opts.launcher });
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner({ launcher: opts.launcher });
  }
}

/**
 * True when `backend` can really run in a task container. The engine must never claim isolation
 * on a backend that would ignore it — or that cannot work there — so this is an allowlist.
 *
 * Taking a launcher is necessary, not sufficient: the agent's CLI must be IN the image and its
 * login must reach the container. Claude and Kimi are always in the base image; every other
 * runner's CLI is added to it the first time a task needs it, and its login is passed per turn
 * (`container-agents.ts`). A runner on this list that has no login in the container still runs
 * there, and the task log says which variable to set.
 */
const LAUNCHER_BACKENDS: ReadonlySet<string> = new Set([
  'claude', 'claude-cli', 'kimi', 'codex', 'opencode', 'pi', 'cursor', 'junie', 'copilot',
]);

export function backendSupportsLauncher(backend: AgentBackend | RunnerId | undefined): boolean {
  return LAUNCHER_BACKENDS.has(backend ?? 'claude');
}
