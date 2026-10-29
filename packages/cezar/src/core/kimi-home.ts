import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Kimi Code keeps its per-user state, on this machine.
 *
 * Its own module because the runner reads token usage from the session log under it.
 */

/** Kimi's per-user home: `KIMI_CODE_HOME` when set (an agent profile sets it), else `~/.kimi-code`. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KIMI_CODE_HOME?.trim();
  return override ? override : join(env.HOME ?? homedir(), '.kimi-code');
}

