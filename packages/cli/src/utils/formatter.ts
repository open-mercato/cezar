import chalk from 'chalk';
import type { IssueStore } from '@cezar/core';

export function formatSyncSummary(created: number, updated: number, unchanged: number): string {
  const parts = [];
  if (created > 0) parts.push(`${created} new`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  return parts.join(', ') || 'no changes';
}

export function printDigestSummary(store: IssueStore): void {
  const digested = store.getIssues({ hasDigest: true });
  if (digested.length === 0) return;

  const counts: Record<string, number> = {};
  for (const issue of digested) {
    const cat = issue.digest?.category ?? 'other';
    counts[cat] = (counts[cat] || 0) + 1;
  }

  const order = ['bug', 'feature', 'docs', 'chore', 'question', 'other'];
  const parts = order
    .filter((c) => counts[c])
    .map((c) => `${counts[c]} ${c}${counts[c] > 1 ? 's' : ''}`);

  console.log(chalk.dim(`  Categories: ${parts.join(' · ')}`));
}
