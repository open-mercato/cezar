import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveProgram } from './disclaim-spawn.ts';

/**
 * The real Cursor binary — `CEZ_CURSOR_AGENT_BIN`, else `cursor-agent` on PATH, else the
 * installer's `~/.local/bin/cursor-agent`, else `agent` on PATH, else a bare `agent` (so a spawn
 * fails with the usual "not found"). Shared by every call site that shells out to the real CLI.
 *
 * Cursor's installer links BOTH names, but `agent` is generic enough that another program owns it
 * on some machines (telemetry 8d304c50: an `agent` 0.2.22 exiting 2 on `status`). Only Cursor
 * ships `cursor-agent`, so it is asked for first — even off PATH, ahead of a generic `agent`.
 * Windows keeps the bare name: its shims differ.
 */
export function resolveCursorAgentBin(
  optsBin?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (optsBin) return optsBin;
  if (env.CEZ_CURSOR_AGENT_BIN) return env.CEZ_CURSOR_AGENT_BIN;
  if (platform === 'win32') return 'agent';
  if (resolveProgram('cursor-agent', env.PATH)) return 'cursor-agent';
  const installed = resolveProgram(join(home, '.local', 'bin', 'cursor-agent'), undefined);
  if (installed) return installed;
  return 'agent';
}

/**
 * Whether a resolved bare `agent` (no override) answered `--version` with something other than
 * Cursor's date-based version (`2026.01.28-fd13201`) — i.e. Cursor is not installed and another
 * program owns the name (telemetry 8d304c50: `agent` 0.2.22). Only a readable semver counts as an
 * answer; silence or garbage stays undecided.
 */
export function isForeignCursorAgent(
  executable: string,
  version: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (executable !== 'agent' || env.CEZ_CURSOR_AGENT_BIN || !version) return false;
  return !/^20\d{2}\.\d{1,2}\.\d{1,2}(?:\D|$)/.test(version);
}
