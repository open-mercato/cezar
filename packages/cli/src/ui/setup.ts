import { input, confirm } from '@inquirer/prompts';
import ora from 'ora';
import chalk from 'chalk';
import type { Config } from '@cezar/core';
import { IssueStore } from '@cezar/core';
import { GitHubService } from '@cezar/core';
import { LLMService } from '@cezar/core';
import { progressBar } from './components/progress.js';
import { printDigestSummary } from '../utils/formatter.js';

export async function runSetupWizard(config: Config): Promise<IssueStore | null> {
  console.log(chalk.bold("\n  Welcome! Let's connect to your GitHub repo.\n"));

  const owner = await input({
    message: 'GitHub owner (org or username):',
    default: config.github.owner || undefined,
    validate: (v) => v.trim().length > 0 || 'Required',
  });

  const repo = await input({
    message: 'Repository name:',
    default: config.github.repo || undefined,
    validate: (v) => v.trim().length > 0 || 'Required',
  });

  config.github.owner = owner.trim();
  config.github.repo = repo.trim();

  if (!config.github.token) {
    console.log(
      chalk.yellow('\n  No GITHUB_TOKEN found. Set it in .env or export it in your shell.'),
    );
    return null;
  }

  if (!config.llm.apiKey) {
    console.log(chalk.yellow('\n  No ANTHROPIC_API_KEY found. Digests will be skipped.'));
  }

  const includeClosed = await confirm({
    message: 'Include closed issues?',
    default: false,
  });

  console.log('');

  // Fetch issues
  const spinner = ora(`Fetching issues from ${owner}/${repo}...`).start();
  const github = new GitHubService(config);

  let issues;
  try {
    issues = await github.fetchAllIssues(includeClosed);
    spinner.succeed(`Fetched ${issues.length} issues from ${owner}/${repo}`);
  } catch (error) {
    spinner.fail('Failed to fetch issues');
    console.error(chalk.red(`  ${(error as Error).message}`));
    console.log(chalk.dim('\n  Check your token and repo name, then try again.\n'));
    return null;
  }

  // Initialize store
  const store = await IssueStore.init(config.store.path, {
    owner: owner.trim(),
    repo: repo.trim(),
  });
  let created = 0;
  for (const issue of issues) {
    const result = store.upsertIssue(issue);
    if (result.action === 'created') created++;
  }
  store.updateMeta({
    lastSyncedAt: new Date().toISOString(),
    totalFetched: issues.length,
  });
  await store.save();

  console.log(chalk.dim(`  ${created} issues stored`));

  // Generate digests if API key is available
  if (config.llm.apiKey) {
    const toDigest = store.getIssues({ hasDigest: false });
    const digestSpinner = ora(`Generating digests  ${progressBar(0, toDigest.length)}`).start();
    try {
      const llm = new LLMService(config);
      const digests = await llm.generateDigests(
        toDigest.map((i) => ({ number: i.number, title: i.title, body: i.body })),
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
      digestSpinner.succeed(`Digested ${digestCount}/${toDigest.length} issues`);
      printDigestSummary(store);
    } catch (error) {
      digestSpinner.warn('Digest generation failed (partial results saved)');
      console.error(chalk.yellow(`  ${(error as Error).message}`));
      await store.save();
    }
  }

  console.log(chalk.green('\n  Setup complete!\n'));
  return store;
}
