import { z } from 'zod';
import type { RootCause } from './analyzer.js';
import { FIX_IMPLEMENTATION_SKILL } from '../skills.js';
import { AGENT_EXECUTION_GUIDANCE } from './agent-guidance.js';
import { stripPhaseMarkers } from './untrusted.js';

export const FixReportSchema = z.object({
  changedFiles: z.array(z.string()),
  approach: z.string(),
  testCommandsRun: z.array(z.string()),
  remainingConcerns: z.array(z.string()).optional(),
});

export type FixReport = z.infer<typeof FixReportSchema>;

export const FIXER_SYSTEM_PROMPT = `You are the FIXER agent. Your job is to implement the smallest correct fix for a bug whose root cause has already been diagnosed.

RULES:
- Prefer Edit over Write. Make the minimum change that resolves the root cause.
- No scope creep: do not refactor, reformat, or fix unrelated issues.
- No new comments unless the WHY is non-obvious.
- Never bypass hooks (no \`--no-verify\`), never force-push, never touch the base branch.
- Only allowlisted Bash commands are available — use them to verify your fix.
- Stop as soon as the tests/typecheck/lint you ran are green.
- Do NOT search the repo for skill/doc files. Everything you need is in this prompt.

${FIX_IMPLEMENTATION_SKILL}

OUTPUT — when done, output ONLY a single JSON object (no markdown fences) matching this schema:
{
  "changedFiles": ["path/to/file.ts", "..."],
  "approach": "2-4 sentences describing what you changed and why",
  "testCommandsRun": ["npm run typecheck", "..."],
  "remainingConcerns": ["optional list of anything flaky or unaddressed"]
}${AGENT_EXECUTION_GUIDANCE}`;

export function buildFixerUserPrompt(opts: {
  issueNumber: number;
  title: string;
  rootCause: RootCause;
  priorAttemptNotes?: string;
}): string {
  const priorSection = opts.priorAttemptNotes
    ? `\n\nPRIOR ATTEMPT — the previous fix was rejected at review. Reviewer notes:\n${opts.priorAttemptNotes}\n\nAddress these concerns in your new fix.`
    : '';

  // Title is attacker-controlled; the root-cause fields are model output that
  // may have echoed injected issue content. Strip any phase markers so neither
  // can hijack the unified-session phase order.
  return `ISSUE #${opts.issueNumber}: ${stripPhaseMarkers(opts.title)}

ROOT CAUSE ANALYSIS:
Summary:      ${stripPhaseMarkers(opts.rootCause.summary)}
Hypothesis:   ${stripPhaseMarkers(opts.rootCause.hypothesis)}
Suspected files: ${opts.rootCause.suspectedFiles.join(', ') || '(none listed)'}
Repro notes:  ${stripPhaseMarkers(opts.rootCause.reproductionNotes ?? '(none)')}
Analyzer confidence: ${opts.rootCause.confidence.toFixed(2)}${priorSection}

Implement the fix and produce the JSON object described in the system prompt.`;
}
