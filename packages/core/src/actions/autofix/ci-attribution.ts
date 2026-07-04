import { z } from 'zod';
import type { CheckRunSummary } from '../../services/github.service.js';
import type { LLMService } from '../../services/llm.service.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type AttributionVerdict = 'ours' | 'unrelated' | 'flaky' | 'unsure';
export type AttributionMethod = 'base-branch-control' | 'llm' | 'degraded';

export interface AttributionResult {
  verdict: AttributionVerdict;
  confidence: number;
  method: AttributionMethod;
  reasoning: string;
  preExistingChecks: string[];
  suggestedFocus?: string;
  model?: string;
  attributedAt: string;
}

export interface AttributionLogTail {
  checkName: string;
  lines: string[];
}

export interface AttributionInput {
  failedChecks: CheckRunSummary[];
  baseChecks: CheckRunSummary[];
  changedFiles: string[];
  prDiff: string;
  logTails?: AttributionLogTail[];
  flakyRerunsSoFar: number;
}

// ─── LLM response schema ──────────────────────────────────────────────────

export const AttributionLlmResultSchema = z.object({
  verdict: z.enum(['ours', 'unrelated', 'flaky', 'unsure']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
  suggestedFocus: z.string().max(500).optional(),
});

export type AttributionLlmResult = z.infer<typeof AttributionLlmResultSchema>;

// ─── Base-branch control (pure, deterministic) ────────────────────────────

const FAIL_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

export interface BaseControlResult {
  preExistingChecks: string[]; // names of PR-failed checks that also fail on base
  nonPreExistingChecks: CheckRunSummary[]; // failed checks that do NOT fail on base
  allPreExisting: boolean;
}

/**
 * Compare failing checks on the PR against completed checks on base-branch HEAD.
 * A check is "pre-existing" if a same-named check on base has already concluded
 * as failure/timed_out/cancelled. Base checks that are still pending are
 * ignored — we only consider decisive signals.
 *
 * If ALL PR-failed checks are pre-existing on base, the failure is deterministically
 * unrelated to our changes. Skips the LLM call entirely in that case.
 */
export function runBaseBranchControl(
  failedChecks: CheckRunSummary[],
  baseChecks: CheckRunSummary[],
): BaseControlResult {
  const baseFailing = new Set(
    baseChecks
      .filter(
        (b) =>
          b.status === 'completed' && b.conclusion != null && FAIL_CONCLUSIONS.has(b.conclusion),
      )
      .map((b) => b.name),
  );

  const preExistingChecks: string[] = [];
  const nonPreExistingChecks: CheckRunSummary[] = [];

  for (const c of failedChecks) {
    if (baseFailing.has(c.name)) preExistingChecks.push(c.name);
    else nonPreExistingChecks.push(c);
  }

  return {
    preExistingChecks,
    nonPreExistingChecks,
    allPreExisting: failedChecks.length > 0 && nonPreExistingChecks.length === 0,
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 12_000; // roughly 3k tokens
const MAX_LOG_LINES_PER_CHECK = 80;

export function buildAttributionPrompt(
  input: AttributionInput,
  baseControl: BaseControlResult,
): string {
  const truncatedDiff =
    input.prDiff.length > MAX_DIFF_CHARS
      ? input.prDiff.slice(0, MAX_DIFF_CHARS) +
        `\n[...diff truncated; showed ${MAX_DIFF_CHARS} of ${input.prDiff.length} chars...]`
      : input.prDiff;

  const changedFilesBlock =
    input.changedFiles.length > 0
      ? input.changedFiles.map((f) => `- ${f}`).join('\n')
      : '_(no changed files reported)_';

  const failedChecksBlock = input.failedChecks
    .map(
      (c) =>
        `- **${c.name}** (conclusion: ${c.conclusion ?? 'unknown'})${c.htmlUrl ? ` — ${c.htmlUrl}` : ''}`,
    )
    .join('\n');

  const preExistingNote =
    baseControl.preExistingChecks.length > 0
      ? `**These checks ALSO fail on the base branch HEAD** (deterministic — they existed before this PR):\n${baseControl.preExistingChecks
          .map((n) => `- ${n}`)
          .join('\n')}\n\nTreat these as "unrelated" automatically.\n\n`
      : '';

  const logsBlock =
    (input.logTails ?? []).length === 0
      ? '_(no log excerpts available — base attribution on file paths and diff)_'
      : (input.logTails ?? [])
          .map((t) => {
            const tail = t.lines.slice(-MAX_LOG_LINES_PER_CHECK).join('\n');
            return `### ${t.checkName}\n\`\`\`\n${tail}\n\`\`\``;
          })
          .join('\n\n');

  const flakyHint =
    input.flakyRerunsSoFar > 0
      ? `\n**IMPORTANT:** We already re-ran failed jobs ${input.flakyRerunsSoFar} time(s) and they failed again. Do NOT return verdict='flaky' — the failure is reproducible.\n`
      : '';

  return `You are attributing a CI failure on an auto-generated pull request. Decide whether the failure was caused by the changes in this PR.

${preExistingNote}**Failed checks on the PR:**
${failedChecksBlock}

**Files changed in the PR:**
${changedFilesBlock}

**PR diff (may be truncated):**
\`\`\`diff
${truncatedDiff}
\`\`\`

**Log tails from failed jobs:**
${logsBlock}
${flakyHint}
Classify the failure as one of:

- **"ours"** — the failing check is clearly caused by the code changes in this PR (e.g. a test for a file we modified is failing; a type error in a file we edited; lint rule violation on an added line).
- **"unrelated"** — the failure is in infrastructure, an unrelated file, a pre-existing bug, or matches a failure on base. The same failure would occur without this PR.
- **"flaky"** — the failure looks transient (network timeout, flaky integration test, rate limit, resource contention) and a re-run would likely pass. Only use this verdict when there are clear flakiness markers (timeouts, connection resets, "ECONNRESET", test retries).
- **"unsure"** — signals are mixed or logs are absent and you cannot make a confident call.

Guidance:
- Weight log evidence highest. A failing test name pointing at a file in "Files changed" is a strong signal for "ours".
- A failing job on a file or workflow step completely unrelated to the diff is a signal for "unrelated".
- Prefer "unsure" with low confidence over guessing.

Respond ONLY with valid JSON — no markdown, no explanation outside the JSON:
{
  "verdict": "ours" | "unrelated" | "flaky" | "unsure",
  "confidence": 0.0 to 1.0,
  "reasoning": "One to three sentences citing concrete evidence from logs, files, or diff.",
  "suggestedFocus": "Optional — if verdict is 'ours', a short hint for the fixer: which file/function/test to target. Omit otherwise."
}`;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Full attribution pipeline:
 *   1. Base-branch control. If all failures are pre-existing on base → unrelated.
 *   2. Otherwise ask the LLM, restricting its attention to non-pre-existing checks.
 *
 * Returns a degraded unsure-verdict rather than throwing when the LLM
 * is unavailable, so the cron worker can still record something.
 */
export async function runCiAttribution(
  input: AttributionInput,
  llm: LLMService | null,
  modelLabel?: string,
): Promise<AttributionResult> {
  const baseControl = runBaseBranchControl(input.failedChecks, input.baseChecks);
  const now = () => new Date().toISOString();

  if (baseControl.allPreExisting) {
    return {
      verdict: 'unrelated',
      confidence: 0.95,
      method: 'base-branch-control',
      reasoning: `All ${input.failedChecks.length} failing check(s) are also failing on the base branch HEAD: ${baseControl.preExistingChecks.join(', ')}. These failures pre-date this PR.`,
      preExistingChecks: baseControl.preExistingChecks,
      attributedAt: now(),
    };
  }

  if (!llm) {
    return {
      verdict: 'unsure',
      confidence: 0,
      method: 'degraded',
      reasoning:
        'LLM unavailable — attribution degraded to unsure. Base-branch control found no pre-existing matches for the failing checks, so a human needs to review.',
      preExistingChecks: baseControl.preExistingChecks,
      attributedAt: now(),
    };
  }

  const prompt = buildAttributionPrompt(input, baseControl);
  const parsed = await llm.analyze(prompt, AttributionLlmResultSchema);

  if (!parsed) {
    return {
      verdict: 'unsure',
      confidence: 0,
      method: 'degraded',
      reasoning:
        'Attribution LLM returned no parseable response. Treat as unsure — human review required.',
      preExistingChecks: baseControl.preExistingChecks,
      attributedAt: now(),
    };
  }

  // Guard against the LLM ignoring the "no flaky after N reruns" instruction.
  if (parsed.verdict === 'flaky' && input.flakyRerunsSoFar > 0) {
    return {
      verdict: 'ours',
      confidence: Math.max(parsed.confidence * 0.6, 0.4),
      method: 'llm',
      reasoning: `LLM suggested 'flaky' but the failure already recurred across ${input.flakyRerunsSoFar + 1} runs — treating as 'ours' with reduced confidence. Original reasoning: ${parsed.reasoning}`,
      preExistingChecks: baseControl.preExistingChecks,
      suggestedFocus: parsed.suggestedFocus,
      model: modelLabel,
      attributedAt: now(),
    };
  }

  return {
    verdict: parsed.verdict,
    confidence: parsed.confidence,
    method: 'llm',
    reasoning: parsed.reasoning,
    preExistingChecks: baseControl.preExistingChecks,
    suggestedFocus: parsed.suggestedFocus,
    model: modelLabel,
    attributedAt: now(),
  };
}
