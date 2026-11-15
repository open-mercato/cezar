import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for an upstream Gemini CLI 0.60 bug found by the real-CLI smoke (#581): a session resumed
 * with ACP `session/load` in the SAME wall-clock minute (UTC) it was created is destroyed.
 *
 * Gemini records each session to `<gemini home>/.gemini/tmp/<project>/chats/` in a file named
 * `session-${new Date().toISOString().slice(0, 16).replace(/:/g, '-')}-${id.slice(0, 8)}.jsonl`
 * (`ChatRecordingService` in the 0.60.0 bundle). `session/load` starts a NEW recording for the
 * loaded id before it reads the history; inside the creation minute that new recording has the
 * original's file name, so it appends a fresh header and a `messages` reset to the original file.
 * The load then fails ("No previous sessions found for this project."), and so does every later
 * load: the history is gone for good. A task that finishes in under a minute and is continued
 * right away — the ordinary "send back" flow — hits it.
 *
 * So before loading, cezar looks for a recording of this session stamped with the current minute
 * and, when there is one, waits for the minute to roll over. It only reads directory names; it
 * never opens or edits Gemini's files.
 */
export function geminiResumeWaitMs(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): number {
  const shortId = sessionId.slice(0, 8);
  if (!/^[A-Za-z0-9-]{8}$/.test(shortId)) return 0;
  const minute = now.toISOString().slice(0, 16).replace(/:/g, '-');
  const name = `session-${minute}-${shortId}.jsonl`;
  const home = env.GEMINI_CLI_HOME?.trim() || homedir();
  const tmp = join(home, '.gemini', 'tmp');
  let projects: string[];
  try {
    projects = readdirSync(tmp);
  } catch {
    return 0;
  }
  if (!projects.some((project) => existsSync(join(tmp, project, 'chats', name)))) return 0;
  // To the next minute, plus a margin for clock skew between cezar and the child.
  return 60_000 - (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()) + 1_500;
}
