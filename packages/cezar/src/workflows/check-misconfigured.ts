/**
 * A check whose command could not run at all is not a verdict on the diff. Sending it to a fix
 * agent buys nothing: `npm test` in a worktree with no `package.json` fails the same way every
 * round, and each round is a full agent session (familywarden: every task failed, its fixer
 * burned the retries, review/gate/PR never ran).
 *
 * This names those cases so the workflow can stop with a clear `misconfigured` outcome instead
 * of entering its fix/retry loop. Kept narrow on purpose — anything that is not unmistakably
 * "the command never ran" stays an ordinary failure, because misreading a real red test as a
 * misconfiguration would skip the fixer the user asked for.
 */

export interface CheckRunResult {
  exitCode: number;
  output: string;
  /** Set when the shell itself could not be spawned (ENOENT, EACCES…). */
  spawnError?: string;
}

/** `bash -lc` exits 127 when the command is not found, 126 when it is found but not executable. */
const EXIT_COMMAND_NOT_FOUND = 127;
const EXIT_NOT_EXECUTABLE = 126;

/** npm (v7+) prints this when the working directory has no `package.json`. */
const NPM_NO_PACKAGE_JSON = /Could not read package\.json: Error: ENOENT/;

/**
 * Why `command` could not run, or `undefined` when it ran and its exit code is a real result.
 * The reason is one short sentence naming the command, written for the step's error line.
 */
export function checkMisconfiguration(command: string, result: CheckRunResult): string | undefined {
  if (result.spawnError) return `\`${command}\` could not be started (${result.spawnError})`;
  if (result.exitCode === EXIT_COMMAND_NOT_FOUND) {
    return `\`${command}\` could not run: command not found (exit 127)${firstLine(result.output, /not found/i)}`;
  }
  if (result.exitCode === EXIT_NOT_EXECUTABLE) {
    return `\`${command}\` could not run: not executable (exit 126)${firstLine(result.output, /permission denied|cannot execute/i)}`;
  }
  if (NPM_NO_PACKAGE_JSON.test(result.output)) {
    return `\`${command}\` could not run: npm found no package.json in the working directory`;
  }
  return undefined;
}

/** ` — <the matching output line>`, for the shell's own wording of what was missing. */
function firstLine(output: string, pattern: RegExp): string {
  const line = output.split('\n').find((l) => pattern.test(l))?.trim();
  return line ? ` — ${line.length > 200 ? `${line.slice(0, 200)}…` : line}` : '';
}
