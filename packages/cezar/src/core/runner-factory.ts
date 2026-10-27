import { existsSync } from 'node:fs';
import type { AgentBackend, AgentRunner, AgentRunSpec, RunnerId } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { JunieRunner } from './junie-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { diskFloorRefusal } from '../disk-space.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 */
export function createRunner(backend: AgentBackend | RunnerId | undefined): AgentRunner {
  return guardWorkingDirectory(createBareRunner(backend));
}

function createBareRunner(backend: AgentBackend | RunnerId | undefined): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'cursor':
      return new CursorAgentRunner();
    case 'pi':
      return new PiRunner();
    case 'junie':
      return new JunieRunner();
    case 'copilot':
      return new CopilotAcpRunner();
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner();
  }
}

/** What a run that cannot start in its directory reports (27d2e432). */
export function missingWorkingDirectoryMessage(backend: string, cwd: string): string {
  return `${backend}: cannot start — the working directory ${cwd} does not exist (the task's worktree was removed outside cezar, or the project moved). Continue re-creates the worktree from the task branch while that branch exists.`;
}

/**
 * Refuse to spawn in a directory that is gone (27d2e432), or on a volume below the free-space
 * floor (9cdcedc3) — there the agent would die mid-write with a bare ENOSPC. Without the first,
 * Node reports the missing cwd as the binary's ENOENT ("`claude` not found on PATH — install …").
 * Wraps by prototype so each runner's own state and extra members stay reachable.
 */
function guardWorkingDirectory(runner: AgentRunner): AgentRunner {
  const check = (spec: AgentRunSpec): void => {
    if (!existsSync(spec.cwd)) throw new Error(missingWorkingDirectoryMessage(runner.backend, spec.cwd));
    const lowDisk = diskFloorRefusal(runner.backend, spec.cwd);
    if (lowDisk) throw new Error(lowDisk);
  };
  const guarded = Object.create(runner) as AgentRunner;
  guarded.startSession = function (spec, onEvent, opts) {
    check(spec);
    return runner.startSession.call(this, spec, onEvent, opts);
  };
  guarded.run = function (spec, onEvent) {
    try {
      check(spec);
    } catch (err) {
      return Promise.reject(err);
    }
    return runner.run.call(this, spec, onEvent);
  };
  return guarded;
}
