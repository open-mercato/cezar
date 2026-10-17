/** A backend refusing to run on the installed CLI — "OpenCode 1.18.0 or newer is required to use
 *  the free tier". The cockpit mirrors this pattern (`packages/web/src/lib/agent-errors.ts`) to
 *  offer the agent's update command next to the error. */
const OUTDATED_BACKEND_RE = /\b\d+\.\d+(?:\.\d+)?\+? or (?:newer|later|higher|above) is required\b|\brequires? (?:version |v)?\d+\.\d+(?:\.\d+)? or (?:newer|later|higher)\b/i;

export function isOutdatedBackendError(message: string): boolean {
  return OUTDATED_BACKEND_RE.test(message);
}
