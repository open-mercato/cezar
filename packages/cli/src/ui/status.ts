import boxen from 'boxen';
import chalk from 'chalk';
import type { IssueStore } from '@cezar/core';
import { VERSION } from '../utils/version.js';

export function renderStatusBox(store: IssueStore | null): void {
  if (!store) {
    const box = boxen(chalk.yellow('No store found. Run `cezar init` to get started.'), {
      padding: 1,
      borderColor: 'yellow',
      title: ` Cezar v${VERSION} `,
      titleAlignment: 'left',
    });
    console.log(box);
    return;
  }

  const meta = store.getMeta();
  const allIssues = store.getIssues();
  const openIssues = store.getIssues({ state: 'open' });
  const closedIssues = store.getIssues({ state: 'closed' });
  const digested = store.getIssues({ hasDigest: true });

  const syncAgo = meta.lastSyncedAt ? formatTimeAgo(new Date(meta.lastSyncedAt)) : 'never';

  const openStr = chalk.bold(`${openIssues.length} open`);
  const closedStr = `${closedIssues.length} closed`;
  const digestStr = `Digested: ${digested.length}/${allIssues.length}`;

  const lines = [
    `${chalk.bold(meta.owner + '/' + meta.repo)}`,
    '',
    `${openStr} · ${closedStr} · synced ${syncAgo}`,
    digestStr,
  ];

  const box = boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'cyan',
    title: ` Cezar v${VERSION} `,
    titleAlignment: 'left',
  });

  console.log(box);
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
