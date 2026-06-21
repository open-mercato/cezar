import chalk from 'chalk';
import type { GitHubService } from '@cezar/core';

/**
 * Returns a `GitHubService`-shaped object whose mutating methods log to stdout
 * instead of hitting the API. Used by `cezar run --dry-run` to enforce the
 * boundary at effect-execution time — the runner itself does not know about
 * dry-run.
 *
 * Read methods are intentionally omitted: the v2 effect palette uses only
 * label / comment / close / assign mutators on the effect-context's github
 * client, so a shallow shim is sufficient.
 */
export function createDryRunGitHub(real: GitHubService): GitHubService {
  const log = (msg: string) => console.log(chalk.dim(`  [dry-run] ${msg}`));

  const shim = {
    async addLabel(issueNumber: number, label: string): Promise<void> {
      log(`label.add #${issueNumber} "${label}"`);
    },
    async removeLabel(issueNumber: number, label: string): Promise<void> {
      log(`label.remove #${issueNumber} "${label}"`);
    },
    async setLabels(issueNumber: number, labels: string[]): Promise<void> {
      log(`label.set #${issueNumber} [${labels.join(', ')}]`);
    },
    async addComment(issueNumber: number, body: string): Promise<number> {
      const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
      log(`comment #${issueNumber} "${preview}"`);
      return 0;
    },
    async closeIssue(
      issueNumber: number,
      reason: 'completed' | 'not_planned' = 'completed',
    ): Promise<void> {
      log(`close #${issueNumber} (${reason})`);
    },
    async addAssignees(issueNumber: number, assignees: string[]): Promise<void> {
      log(`assign #${issueNumber} [${assignees.join(', ')}]`);
    },
  };

  // Compose over the real service so any method the runner reaches for that
  // we haven't shimmed falls through to the live client (read-only fetches).
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop in shim) return (shim as Record<string | symbol, unknown>)[prop];
      return Reflect.get(target, prop, receiver);
    },
  }) as GitHubService;
}
