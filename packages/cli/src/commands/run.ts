import chalk from 'chalk';
import type { Config } from '@cezar/core';
import {
  loadActionCatalog,
  runActionAcrossIssues,
  type IssueScope,
} from '../utils/cli-action-runner.js';

interface RunOptions {
  all?: boolean;
  unanalyzed?: boolean;
  issue?: number;
  apply?: boolean;
  dryRun?: boolean;
}

export async function runCommand(actionName: string, opts: RunOptions, config: Config): Promise<void> {
  if (opts.apply && opts.dryRun) {
    console.error(chalk.red('Cannot pass both --apply and --dry-run.'));
    process.exit(1);
  }

  const catalog = await loadActionCatalog();
  const action = catalog.find((a) => a.name === actionName);
  if (!action) {
    console.error(chalk.red(`Unknown action: ${actionName}\n`));
    console.error(chalk.dim('Available actions:'));
    for (const a of catalog) {
      console.error(chalk.dim(`  ${a.name.padEnd(22)} ${a.description ?? ''}`));
    }
    process.exit(1);
  }

  const scope: IssueScope = opts.issue != null
    ? { kind: 'single', number: opts.issue }
    : opts.all
      ? { kind: 'all' }
      : { kind: 'unanalyzed' };

  const result = await runActionAcrossIssues(
    action,
    { scope, apply: opts.apply === true, dryRun: opts.dryRun === true },
    config,
  );
  if (result.failed > 0) process.exit(1);
}
