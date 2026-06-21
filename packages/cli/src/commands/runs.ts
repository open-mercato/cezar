import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import type { Config } from '@cezar/core';
import { runsDir, listRunSummaries, type LocalRunSummary } from '../utils/runs-store.js';

const EMPTY_STATE =
  'No local engine runs yet. Set `workflow.useEngine: true` in `.issuemanagerrc.json` ' +
  'and run an autofix; the web cockpit (`/cockpit`) tracks runs for the SaaS.';

export async function runsCommand(runId: string | undefined, config: Config): Promise<void> {
  const dir = runsDir(config.store?.path);
  const summaries = await listRunSummaries(dir);

  if (summaries.length === 0) {
    console.log(`\n  ${chalk.dim(EMPTY_STATE)}\n`);
    return;
  }

  if (runId) {
    const run =
      summaries.find((r) => r.id === runId) ?? summaries.find((r) => r.id.startsWith(runId));
    if (!run) {
      console.error(chalk.red(`No run found matching '${runId}'.`));
      process.exit(1);
    }
    printDetail(run);
    return;
  }

  printList(summaries);
}

function printList(summaries: LocalRunSummary[]): void {
  const table = new Table({
    head: ['ID', 'Workflow', 'Issue', 'Status', 'Age', 'Steps'].map((h) => chalk.bold(h)),
    style: { head: [], border: [] },
  });
  for (const r of summaries) {
    table.push([
      r.id.slice(0, 8),
      r.workflow,
      `#${r.issueNumber}`,
      colorStatus(r.status),
      timeAgo(r.startedAt),
      String(r.steps.length),
    ]);
  }
  console.log(`\n  ${chalk.bold('Local engine runs')} ${chalk.dim(`(${summaries.length})`)}\n`);
  console.log(table.toString());
  console.log(`\n  ${chalk.dim('cezar runs <id>')} for step-by-step detail.\n`);
}

function printDetail(run: LocalRunSummary): void {
  const header =
    `${chalk.bold(run.workflow)}  ·  issue #${run.issueNumber}  ·  ${colorStatus(run.status)}\n` +
    `${chalk.dim('id')} ${run.id}\n` +
    `${chalk.dim('started')} ${run.startedAt}  ${chalk.dim('finished')} ${run.finishedAt}\n` +
    `${chalk.dim('outcome')} ${run.outcome}`;
  console.log(boxen(header, { padding: 1, margin: 1, borderStyle: 'round' }));

  const table = new Table({
    head: ['Step', 'Iter', 'Backend', 'Model', 'Status', 'Tokens'].map((h) => chalk.bold(h)),
    style: { head: [], border: [] },
  });
  for (const s of run.steps) {
    table.push([
      s.stepId,
      String(s.iteration),
      s.backend,
      s.model,
      colorStatus(s.status),
      s.tokensUsed ? String(s.tokensUsed) : '—',
    ]);
  }
  console.log(table.toString());

  const withSummary = run.steps.filter((s) => s.summary || s.error);
  if (withSummary.length > 0) {
    console.log('');
    for (const s of withSummary) {
      if (s.summary) console.log(`  ${chalk.dim(s.stepId)}: ${s.summary}`);
      if (s.error) console.log(`  ${chalk.red(s.stepId)}: ${s.error}`);
    }
  }
  console.log('');
}

function colorStatus(status: string): string {
  if (status === 'finished' || status === 'succeeded' || status === 'pr-opened')
    return chalk.green(status);
  if (status === 'failed') return chalk.red(status);
  if (status === 'running' || status === 'paused') return chalk.yellow(status);
  return chalk.dim(status);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
