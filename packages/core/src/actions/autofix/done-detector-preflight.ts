import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

/**
 * Done-detector prompt + schema, scoped to the autofix preflight. Previously
 * lived under `actions/done-detector/`; inlined here when the legacy action
 * plugins were retired (commit 2b2) so the orchestrator stays self-contained.
 */

export const DoneDetectorResponseSchema = z.object({
  results: z.array(
    z.object({
      number: z.number(),
      isDone: z.boolean(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
      draftComment: z.string(),
    }),
  ),
});

export type DoneDetectorResponse = z.infer<typeof DoneDetectorResponseSchema>;

export interface IssueWithPRs {
  issue: StoredIssue;
  mergedPRs: Array<{ prNumber: number; prTitle: string }>;
}

export function buildDoneDetectorPrompt(candidates: IssueWithPRs[]): string {
  const issueList = candidates.map(formatCandidate).join('\n\n---\n\n');

  return `You are reviewing open GitHub issues that have merged pull requests referencing them. Your job is to assess whether each issue has been resolved by the merged PR(s).

CONFIDENCE GUIDELINES:
- 0.90–1.00: The PR title/description explicitly fixes this issue (e.g. "Fix #123", "Resolve missing translations for #123")
- 0.70–0.89: The PR is clearly related and likely resolves the issue based on the title and issue summary
- Below 0.70: The PR is tangentially related or it's unclear whether it fully resolves the issue

RULES:
- Set isDone=true only if confidence >= 0.70
- Set isDone=false if the PR seems tangential or only partially addresses the issue
- Draft a polite closing comment when isDone=true, mentioning the resolving PR(s) by number
- For isDone=false, set draftComment to an empty string
- Consider ALL merged PRs for each issue — multiple PRs may together resolve an issue

ISSUES WITH MERGED PR REFERENCES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 243,
      "isDone": true,
      "confidence": 0.95,
      "reason": "PR #281 explicitly fixes the missing translations described in this issue",
      "draftComment": "This issue appears to have been resolved by PR #281. Closing as completed."
    }
  ]
}`;
}

function formatCandidate(candidate: IssueWithPRs): string {
  const { issue, mergedPRs } = candidate;
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  const prList = mergedPRs.map((pr) => `  - PR #${pr.prNumber}: ${pr.prTitle}`).join('\n');

  return `#${issue.number}${labels} — ${issue.title}
Category: ${d.category} | Area: ${d.affectedArea}
Summary: ${d.summary}
Merged PRs referencing this issue:
${prList}`;
}
