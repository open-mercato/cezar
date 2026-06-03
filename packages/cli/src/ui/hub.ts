import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { clearScreen, renderLogo } from './logo.js';
import { renderStatusBox } from './status.js';
import { runSetupWizard } from './setup.js';
import { IssueStore } from '@cezar/core';
import type { ActionDef, Config } from '@cezar/core';
import { syncCommand } from '../commands/sync.js';
import {
  loadActionCatalog,
  runActionAcrossIssues,
  type IssueScope,
} from '../utils/cli-action-runner.js';

export async function launchHub(store: IssueStore | null, config: Config): Promise<void> {
  if (!store) {
    clearScreen();
    renderLogo();
    store = await runSetupWizard(config);
    if (!store) return;
  }

  const meta = store.getMeta();
  if (!config.github.owner) config.github.owner = meta.owner;
  if (!config.github.repo) config.github.repo = meta.repo;

  while (true) {
    clearScreen();
    renderLogo();
    renderStatusBox(store);

    const choice = await select({
      message: 'What would you like to do?',
      choices: [
        { name: '▶  Run an action', value: 'run' },
        { name: '🔄  Sync with GitHub', value: 'sync' },
        { name: '✕   Exit', value: 'exit' },
      ],
    });

    if (choice === 'exit') return;

    if (choice === 'sync') {
      try {
        await syncCommand({}, config);
        const reloaded = await IssueStore.loadOrNull(config.store.path);
        if (!reloaded) {
          console.error(
            chalk.red('  Store disappeared after sync. Run `cezar init` to recreate it.'),
          );
          return;
        }
        store = reloaded;
      } catch (err) {
        if ((err as Error).name === 'ExitPromptError') throw err;
        console.error(chalk.red(`\n  sync failed: ${(err as Error).message}`));
        console.log(chalk.dim('\n  Press Enter to continue.'));
        await input({ message: '' }).catch(() => '');
      }
      continue;
    }

    if (choice === 'run') {
      try {
        await runActionFlow(config);
      } catch (err) {
        if ((err as Error).name === 'ExitPromptError') throw err;
        console.error(chalk.red(`\n  action failed: ${(err as Error).message}`));
      }
      console.log(chalk.dim('\n  Press Enter to continue.'));
      await input({ message: '' }).catch(() => '');
    }
  }
}

async function runActionFlow(config: Config): Promise<void> {
  const catalog = await loadActionCatalog();
  if (catalog.length === 0) {
    console.log(chalk.yellow('  No actions available.'));
    return;
  }

  const byTarget = groupByTarget(catalog);
  const choices: Array<{ name: string; value: string }> = [];
  for (const target of ['issue', 'pr'] as const) {
    const actions = byTarget.get(target) ?? [];
    if (actions.length === 0) continue;
    choices.push({ name: chalk.dim(`── ${target} ──`), value: `__heading_${target}` });
    for (const a of actions) {
      const desc = a.description ? chalk.dim(` — ${a.description}`) : '';
      choices.push({ name: `${a.name}${desc}`, value: a.name });
    }
  }
  choices.push({ name: chalk.dim('← Back'), value: '__back' });

  const actionName = await select({
    message: 'Pick an action',
    choices,
    pageSize: 18,
  });
  if (actionName === '__back' || actionName.startsWith('__heading_')) return;
  const action = catalog.find((a) => a.name === actionName);
  if (!action) return;

  const scopeKind = await select<'unanalyzed' | 'all' | 'single' | '__back'>({
    message: 'Scope',
    choices: [
      { name: 'Unanalyzed only', value: 'unanalyzed' },
      { name: 'All issues', value: 'all' },
      { name: 'Single issue by number', value: 'single' },
      { name: chalk.dim('← Back'), value: '__back' },
    ],
  });
  if (scopeKind === '__back') return;

  let scope: IssueScope;
  if (scopeKind === 'single') {
    const n = await input({
      message: 'Issue number',
      validate: (v) => /^\d+$/.test(v.trim()) || 'Enter a positive integer',
    });
    scope = { kind: 'single', number: parseInt(n.trim(), 10) };
  } else if (scopeKind === 'all') {
    scope = { kind: 'all' };
  } else {
    scope = { kind: 'unanalyzed' };
  }

  const apply = await confirm({
    message: 'Apply effects to GitHub? (No = dry-run, prints what would happen.)',
    default: false,
  });

  await runActionAcrossIssues(action, { scope, apply, dryRun: !apply }, config);
}

function groupByTarget(catalog: ActionDef[]): Map<'issue' | 'pr', ActionDef[]> {
  const out = new Map<'issue' | 'pr', ActionDef[]>();
  for (const a of catalog) {
    const list = out.get(a.target) ?? [];
    list.push(a);
    out.set(a.target, list);
  }
  return out;
}
