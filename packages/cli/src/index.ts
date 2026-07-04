#!/usr/bin/env node
import 'dotenv/config';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadConfig, IssueStore } from '@cezar/core';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { statusCommand } from './commands/status.js';
import { runCommand } from './commands/run.js';
import { runsCommand } from './commands/runs.js';
import { launchHub } from './ui/hub.js';
import { VERSION } from './utils/version.js';

const program = new Command()
  .name('cezar')
  .description('AI-powered GitHub issue management')
  .version(VERSION);

program
  .command('init')
  .description('Fetch all issues and generate digests')
  .option('-o, --owner <owner>', 'GitHub repository owner')
  .option('-r, --repo <repo>', 'GitHub repository name')
  .option('-t, --token <token>', 'GitHub token')
  .option('--include-closed', 'Include closed issues')
  .option('--no-digest', 'Skip LLM digest generation')
  .option('--force', 'Reinitialize even if store exists')
  .action(async (opts) => {
    const config = await loadConfig({
      github: {
        owner: opts.owner ?? '',
        repo: opts.repo ?? '',
        token: opts.token ?? '',
      },
    });
    await initCommand(opts, config);
  });

program
  .command('sync')
  .description('Pull new/updated issues from GitHub')
  .option('-t, --token <token>', 'GitHub token')
  .option('--include-closed', 'Include closed issues')
  .action(async (opts) => {
    const config = await loadConfig();
    await syncCommand(opts, config);
  });

program
  .command('status')
  .description('Show store summary')
  .action(async () => {
    const config = await loadConfig();
    await statusCommand(config);
  });

program
  .command('run <action>')
  .description('Run a data-driven Action against issues in the local store')
  .option('--all', 'Run against every issue in the store')
  .option(
    '--unanalyzed',
    'Run only against issues without prior analysis for this action (default)',
  )
  .option('--issue <n>', 'Target a single issue number', (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== v.trim()) {
      throw new InvalidArgumentError(`--issue must be a positive integer, got "${v}".`);
    }
    return n;
  })
  .option('--apply', 'Apply effects to GitHub (default is dry-run)')
  .option('--dry-run', 'Force dry-run; never write to GitHub')
  .action(async (actionName, opts) => {
    const config = await loadConfig();
    await runCommand(actionName, opts, config);
  });

program
  .command('runs [id]')
  .description(
    'List local workflow-engine runs (or show one in detail). Populated when workflow.useEngine is on; the web cockpit is the SaaS equivalent.',
  )
  .action(async (id) => {
    const config = await loadConfig();
    await runsCommand(id, config);
  });

// No subcommand → launch interactive hub
program.action(async () => {
  try {
    const config = await loadConfig();
    const store = await IssueStore.loadOrNull(config.store.path);
    await launchHub(store, config);
  } catch (error) {
    if ((error as Error).name === 'ExitPromptError') {
      // User cancelled with Ctrl+C
      process.exit(0);
    }
    throw error;
  }
});

program.parseAsync().catch((error) => {
  console.error(chalk.red((error as Error).message));
  process.exit(1);
});
