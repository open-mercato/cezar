import chalk from 'chalk';
import ora from 'ora';
import type { Config } from '@cezar/core';
import { IssueStore } from '@cezar/core';
import { GitHubService } from '@cezar/core';
import { LLMService } from '@cezar/core';
import { progressBar } from '../ui/components/progress.js';
import { printDigestSummary } from '../utils/formatter.js';

interface SyncOptions {
  token?: string;
  includeClosed?: boolean;
}

export async function syncCommand(opts: SyncOptions, config: Config): Promise<void> {
  if (opts.token) config.github.token = opts.token;

  const store = await IssueStore.loadOrNull(config.store.path);
  if (!store) {
    console.error(chalk.red("Store not found. Run 'cezar init' first."));
    process.exit(1);
  }

  const meta = store.getMeta();
  config.github.owner = meta.owner;
  config.github.repo = meta.repo;

  const spinner = ora('Syncing with GitHub...').start();
  const github = new GitHubService(config);
  const includeClosed = opts.includeClosed ?? config.sync.includeClosed;

  let issues;
  try {
    if (meta.lastSyncedAt) {
      issues = await github.fetchIssuesSince(meta.lastSyncedAt, includeClosed);
    } else {
      issues = await github.fetchAllIssues(includeClosed);
    }
  } catch (error) {
    spinner.fail('Failed to fetch issues');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let closed = 0;

  for (const issue of issues) {
    const result = store.upsertIssue(issue);
    if (result.action === 'created') created++;
    else if (result.action === 'updated') updated++;
    else unchanged++;
    if (result.stateChanged) closed++;
  }

  store.updateMeta({ lastSyncedAt: new Date().toISOString() });
  await store.save();

  const parts = [`${created} new`, `${updated} updated`];
  if (closed > 0) parts.push(`${closed} state changed`);
  spinner.succeed(`Fetched ${issues.length} issues — ${parts.join(', ')}`);

  // Re-digest any issues that need it
  const needsDigest = store.getIssues({ hasDigest: false });
  if (needsDigest.length > 0) {
    const digestSpinner = ora(`Generating digests  ${progressBar(0, needsDigest.length)}`).start();
    try {
      const llm = new LLMService(config);
      const digests = await llm.generateDigests(
        needsDigest.map((i) => ({ number: i.number, title: i.title, body: i.body })),
        config.sync.digestBatchSize,
        (done, total) => {
          digestSpinner.text = `Generating digests  ${progressBar(done, total)}`;
        },
      );

      let digestCount = 0;
      for (const [number, digest] of digests) {
        store.setDigest(number, digest);
        digestCount++;
      }
      await store.save();
      digestSpinner.succeed(`Re-digested ${digestCount} issues`);
      printDigestSummary(store);
    } catch (error) {
      digestSpinner.warn('Digest generation failed (partial results saved)');
      console.error(chalk.yellow((error as Error).message));
      await store.save();
      process.exit(2);
    }
  }

  // Fetch comments for issues with new/changed comments
  const needsComments = store
    .getIssues()
    .filter(
      (i) =>
        i.commentCount > 0 &&
        (i.commentsFetchedAt === null || i.comments.length !== i.commentCount),
    );
  if (needsComments.length > 0) {
    const commentSpinner = ora(
      `Fetching comments  ${progressBar(0, needsComments.length)}`,
    ).start();
    try {
      const commentMap = await github.fetchCommentsForIssues(
        needsComments.map((i) => i.number),
        (done, total) => {
          commentSpinner.text = `Fetching comments  ${progressBar(done, total)}`;
        },
      );
      let commentCount = 0;
      for (const [number, comments] of commentMap) {
        store.setComments(number, comments);
        commentCount++;
      }
      await store.save();
      commentSpinner.succeed(`Fetched comments for ${commentCount} issue(s)`);
    } catch (error) {
      commentSpinner.warn('Comment fetching failed (partial results saved)');
      console.error(chalk.yellow((error as Error).message));
      await store.save();
    }
  }

  // Refresh org members if stale (>24h)
  const orgMembersFetchedAt = meta.orgMembersFetchedAt;
  const orgStaleMs = 24 * 60 * 60 * 1000;
  if (!orgMembersFetchedAt || Date.now() - new Date(orgMembersFetchedAt).getTime() > orgStaleMs) {
    const orgSpinner = ora('Refreshing org members...').start();
    try {
      const orgMembers = await github.fetchOrgMembers(meta.owner);
      store.updateMeta({
        orgMembers,
        orgMembersFetchedAt: new Date().toISOString(),
      });
      await store.save();
      orgSpinner.succeed(`Found ${orgMembers.length} org member(s)`);
    } catch {
      orgSpinner.warn('Could not refresh org members');
    }
  }

  // Summary
  const unanalyzed = store
    .getIssues({ state: 'open', hasDigest: true })
    .filter((i) => i.analysis.duplicatesAnalyzedAt === null).length;
  if (unanalyzed > 0) {
    console.log(
      chalk.dim(`  ${unanalyzed} issues need duplicate check — run 'cezar run duplicates'`),
    );
  }
}
