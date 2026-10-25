import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { cezarHomeDir } from '../paths.ts';

/**
 * Where Kimi Code keeps its per-user state, on this machine.
 *
 * Its own module because both sides of the isolation boundary need it — the runner reads token
 * usage from the session log under it, and the container launcher mounts parts of it — and those
 * two must not import each other.
 */

/** Kimi's per-user home: `KIMI_CODE_HOME` when set (an agent profile sets it), else `~/.kimi-code`. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KIMI_CODE_HOME?.trim();
  return override ? override : join(env.HOME ?? homedir(), '.kimi-code');
}

/**
 * The home an ISOLATED Kimi agent uses, on the host: mounted at `/root/.kimi-code` in its
 * container. The agent's sessions land here — readable by cezar for token usage and resumable by
 * the next turn — while your own `~/.kimi-code` history stays out of its reach. The Claude
 * equivalent is `~/.claude-agent`.
 */
export function agentKimiHome(): string {
  return join(homedir(), '.kimi-agent');
}

/**
 * The agent homes an ISOLATED task of `repoRoot` gets, on the host — one pair PER PROJECT.
 *
 * One shared home for every task of every project let any isolated agent read every other
 * project's transcripts (`projects/*.jsonl`, tool output and printed secrets included) and plant
 * a hook in `settings.json` or a `CLAUDE.md` that then ran in every later isolated task, with that
 * task's credentials. Per project, a task can only reach its own project's history — which is
 * also what Continue needs. Under `cezarHomeDir()` like every other piece of cezar's per-user
 * state, so `CEZ_HOME` relocates it and tests never touch the real home.
 */
export function agentHomesFor(repoRoot: string, env: NodeJS.ProcessEnv = process.env): { claude: string; kimi: string } {
  const key = `${basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 10)}`;
  const base = join(cezarHomeDir(env), 'agent-homes', key);
  return { claude: join(base, 'claude'), kimi: join(base, 'kimi') };
}
