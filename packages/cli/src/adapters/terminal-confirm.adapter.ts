import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { ConfirmationPort, PreflightSummary, RootCausePrompt } from '@cezar/core';

/**
 * Terminal ConfirmationPort impl. Wraps @inquirer/prompts and prints
 * formatted panels via chalk.
 */
export class TerminalConfirmAdapter implements ConfirmationPort {
  async confirmPreflight(summary: PreflightSummary): Promise<boolean> {
    const apply = summary.mode === 'apply';
    console.log('');
    console.log(chalk.bold('Autofix preflight'));
    console.log('─'.repeat(55));
    console.log(`  Repo root:   ${summary.repoRoot}`);
    console.log(`  Base branch: ${summary.baseBranch}`);
    console.log(`  Mode:        ${apply ? chalk.green('APPLY') : chalk.cyan('DRY-RUN')}`);
    console.log(`  Max attempts per issue: ${summary.maxAttemptsPerIssue}`);
    console.log(`  Token budget per attempt: ${summary.tokenBudgetPerAttempt.toLocaleString()}`);
    console.log(`  Eligible issues: ${summary.eligibleIssueCount}`);
    console.log('');

    return confirm({
      message: apply
        ? 'Proceed? This WILL push branches and open draft PRs for bug issues.'
        : 'Proceed with dry-run? No branches will be pushed.',
      default: !apply,
    });
  }

  async confirmRootCause(prompt: RootCausePrompt): Promise<'proceed' | 'skip'> {
    console.log('');
    console.log(chalk.bold(`Root-cause analysis for #${prompt.issueNumber}`));
    console.log('─'.repeat(55));
    console.log(`  Title:      ${prompt.issueTitle}`);
    console.log(`  Summary:    ${prompt.rootCause}`);
    console.log(`  Confidence: ${prompt.confidence.toFixed(2)}`);
    if (prompt.evidence.length > 0) {
      console.log(`  Evidence:   ${prompt.evidence.join(', ')}`);
    }
    console.log('');

    return select<'proceed' | 'skip'>({
      message: 'Proceed with fix implementation?',
      choices: [
        { name: 'Proceed — let the fixer agent make the change', value: 'proceed' },
        { name: 'Skip this issue', value: 'skip' },
      ],
    });
  }

  async confirm(message: string): Promise<boolean> {
    return confirm({ message, default: false });
  }
}
