import chalk from 'chalk';
import type { Config } from '@cezar/core';
import { IssueStore } from '@cezar/core';

export async function statusCommand(config: Config): Promise<void> {
  const store = await IssueStore.loadOrNull(config.store.path);
  if (!store) {
    console.error(chalk.red("Store not found. Run 'cezar init' first."));
    process.exit(1);
  }

  const meta = store.getMeta();
  const allIssues = store.getIssues();
  const openIssues = store.getIssues({ state: 'open' });
  const closedIssues = store.getIssues({ state: 'closed' });
  const digested = store.getIssues({ hasDigest: true });
  const unanalyzed = openIssues.filter((i) => i.digest && i.analysis.duplicatesAnalyzedAt === null);

  const syncAgo = meta.lastSyncedAt ? formatTimeAgo(new Date(meta.lastSyncedAt)) : 'never';

  console.log('');
  console.log(chalk.bold(`  Cezar — ${meta.owner}/${meta.repo}`));
  console.log('');
  console.log(`  ${openIssues.length} open · ${closedIssues.length} closed · synced ${syncAgo}`);
  console.log(
    `  Digested: ${digested.length}/${allIssues.length} · Unanalyzed: ${unanalyzed.length}`,
  );
  console.log('');
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
