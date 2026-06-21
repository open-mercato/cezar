// Commit-message / PR-body / CI-follow-up text builders. Extracted out of
// `orchestrator.ts` (unchanged content) so the Phase 2 workflow engine and the
// legacy orchestrator share one source of truth for what gets written to git
// and GitHub. orchestrator.ts re-exports these.
import type { RootCause } from './prompts/analyzer.js';
import type { FixReport } from './prompts/fixer.js';
import type { ReviewVerdict } from './prompts/reviewer.js';
import { normalizeTitle } from './prompts/untrusted.js';

export interface CiFollowupTextInput {
  issueNumber: number;
  prNumber: number;
  attemptIndex: number;
  attemptMax: number;
  attribution: {
    reasoning: string;
    suggestedFocus?: string;
    preExistingChecks?: string[];
  };
  failedCheckNames: string[];
  logTails?: Array<{ checkName: string; lines: string[] }>;
}

export function buildCiFollowupNotes(input: CiFollowupTextInput): string {
  const parts: string[] = [];
  parts.push(
    'CI FAILURE CONTEXT — this is a follow-up adjustment. The prior autofix commit caused CI to fail.',
  );
  parts.push('');
  parts.push(`Attribution reasoning:\n${input.attribution.reasoning}`);
  if (input.attribution.suggestedFocus) {
    parts.push(`\nSuggested focus:\n${input.attribution.suggestedFocus}`);
  }
  if (input.failedCheckNames.length > 0) {
    parts.push(`\nFailing checks to make green: ${input.failedCheckNames.join(', ')}`);
  }
  if (input.logTails && input.logTails.length > 0) {
    parts.push('\nFailing job log tails:');
    for (const t of input.logTails) {
      const tail = t.lines.slice(-40).join('\n');
      parts.push(`\n### ${t.checkName}\n\`\`\`\n${tail}\n\`\`\``);
    }
  }
  parts.push(
    '\nMake the minimum change that turns the failing checks green without breaking the existing fix.',
  );
  return parts.join('\n');
}

export function buildCiFollowupCommitMessage(
  input: CiFollowupTextInput,
  title: string,
  report: FixReport,
): string {
  return `fix: CI follow-up for ${normalizeTitle(title)} (#${input.issueNumber})

${report.approach}

Attempt ${input.attemptIndex}/${input.attemptMax} — addresses CI failure on PR #${input.prNumber}.

Co-authored-by: cezar-autofix <noreply@cezar>
`;
}

export function buildCiFollowupPrComment(
  input: CiFollowupTextInput,
  fixReport: FixReport,
  verdict: Required<ReviewVerdict>,
): string {
  const files =
    fixReport.changedFiles.length > 0
      ? fixReport.changedFiles.map((f) => `- \`${f}\``).join('\n')
      : '_(none reported)_';
  const tests =
    fixReport.testCommandsRun.length > 0
      ? fixReport.testCommandsRun.map((c) => `- \`${c}\``).join('\n')
      : '_(none)_';
  const focus = input.attribution.suggestedFocus
    ? `\n**Focus:** ${input.attribution.suggestedFocus}`
    : '';
  return `## 🤖 Cezar CI follow-up (attempt ${input.attemptIndex}/${input.attemptMax})

Cezar re-ran against the failing CI and pushed an adjustment.${focus}

**Targeted failing checks:** ${input.failedCheckNames.join(', ') || '_(none listed)_'}

**Approach:** ${fixReport.approach}

**Files changed:**
${files}

**Verification:**
${tests}

**Automated review:** \`${verdict.verdict}\`
${verdict.summary}

A human reviewer should still confirm correctness before merge.`;
}

export function buildCommitMessage(issueNumber: number, title: string, report: FixReport): string {
  return `fix: ${normalizeTitle(title)} (#${issueNumber})

${report.approach}

Fixes #${issueNumber}

Co-authored-by: cezar-autofix <noreply@cezar>
`;
}

export function buildPrBody(
  issueNumber: number,
  rootCause: RootCause,
  fixReport: FixReport,
  verdict: Required<ReviewVerdict>,
): string {
  const concerns =
    (fixReport.remainingConcerns ?? []).map((c) => `- ${c}`).join('\n') || '_(none)_';
  const reviewIssues =
    verdict.issues.length === 0
      ? '_(no issues raised)_'
      : verdict.issues
          .map(
            (i) =>
              `- **${i.severity}** ${i.file ? `\`${i.file}\`${i.line ? `:${i.line}` : ''}` : ''}: ${i.comment}`,
          )
          .join('\n');

  return `## Automated fix for #${issueNumber}

Fixes #${issueNumber}

> This PR was opened by [cezar](https://github.com/comerito/cezar) autofix. It is a **draft** — a human reviewer must verify correctness before it merges.

### Root cause
${rootCause.summary}

${rootCause.hypothesis}

### Approach
${fixReport.approach}

### Files changed
${fixReport.changedFiles.map((f) => `- \`${f}\``).join('\n') || '_(none)_'}

### Verification
Commands run by the fixer:
${fixReport.testCommandsRun.map((c) => `- \`${c}\``).join('\n') || '_(none)_'}

### Review (automated)
**Verdict:** \`${verdict.verdict}\`

${verdict.summary}

Issues raised:
${reviewIssues}

### Remaining concerns
${concerns}
`;
}
