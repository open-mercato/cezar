/**
 * What the cockpit-facing CLIs (`cez task`, `cez automation`, `cez runs`) answer when they have no
 * cockpit address (#1080).
 *
 * `CEZ_API_URL` is deliberately never defaulted: for an agent, the variable being absent IS the
 * signal that the cockpit withheld dispatch or automations (`builtin-skill.ts`, `run.ts`
 * `dispatchReachable`), and a loopback fallback would turn that into writes against whichever
 * cockpit happens to own the port. So the fix is the message, not the resolution.
 *
 * Two callers read it. Inside a cezar task (`CEZ_TASK_ID`, which the engine sets for every agent)
 * the text is the agent instruction each CLI already had: stop and report, never improvise.
 * Everyone else is a person at a shell, and for them "only works inside a task" was false — the
 * CLIs work from any shell given the address, so that is what they are told.
 */
export const DEFAULT_COCKPIT_URL = 'http://127.0.0.1:4321';

export interface MissingCockpitMessage {
  /** The command as typed, e.g. `cez automation`. */
  command: string;
  /** A read-only invocation to show a person, e.g. `cez automation list`. */
  example: string;
  /** Said to an agent inside a task, after "CEZ_API_URL is not set — ". */
  insideTask: string;
}

export function missingCockpitMessage(message: MissingCockpitMessage, env: { CEZ_TASK_ID?: string }): string {
  if (env.CEZ_TASK_ID) return `${message.command}: CEZ_API_URL is not set — ${message.insideTask}`;
  return [
    `${message.command}: CEZ_API_URL is not set, so there is no cockpit to talk to.`,
    `Point it at a running cockpit — the address it printed after "cockpit →" when it started (${DEFAULT_COCKPIT_URL} by default):`,
    `  CEZ_API_URL=${DEFAULT_COCKPIT_URL} ${message.example}`,
    'On a cockpit serving several projects, add CEZ_PROJECT_ID=<id> (`cezar projects` lists them); without it the command addresses the project the cockpit was started in.',
    'Inside a cezar task the cockpit sets this variable itself — if it is missing there, the feature is off: do not set it by hand.',
  ].join('\n');
}
