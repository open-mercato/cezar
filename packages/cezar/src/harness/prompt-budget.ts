import { Buffer } from 'node:buffer';

/**
 * Harness phases deliberately use fresh sessions, but a fresh session can
 * still be overfilled by one giant task/review packet. Keep enough room for a
 * useful model response and fail before buying a model invocation when the
 * complete serialized prompt is too large.
 */
export const HARNESS_CONTEXT_BUDGET_BYTES = 200_000;
export const HARNESS_OUTPUT_RESERVE_BYTES = 20_000;
export const HARNESS_PROMPT_BUDGET_BYTES =
  HARNESS_CONTEXT_BUDGET_BYTES - HARNESS_OUTPUT_RESERVE_BYTES;

export const HARNESS_RESULT_LIMITS = {
  shortText: 500,
  text: 4_000,
  summary: 20_000,
  path: 1_000,
  paths: 200,
  findings: 50,
  questions: 50,
} as const;

/** Bound greedy line splitting and two simultaneous parts per advisor (harness.mjs). */
export function advisorCouncilTimeoutMs(
  models: readonly { timeoutMs?: unknown; maxInputBytes?: unknown }[],
  subjectBytes: number,
  fixedBytes: number,
): number {
  return Math.max(600_000, ...models.map((model) => {
    const parts = advisorSubjectParts(model, subjectBytes, fixedBytes);
    return Math.ceil(parts / 2) * (Number(model.timeoutMs) || 600_000);
  })) + 120_000;
}

function advisorSubjectParts(model: { maxInputBytes?: unknown }, subjectBytes: number, fixedBytes: number): number {
  const subjectBudget = Math.max(1_024, (Number(model.maxInputBytes) || 180_000) - fixedBytes - 16_384);
  return subjectBytes <= subjectBudget ? 1 : 2 * Math.ceil(subjectBytes / (subjectBudget - 4)) + 1;
}

/** Repeated findings need headroom, but cannot authorize an unbounded read. */
export function advisorCouncilResultMaxBytes(
  models: readonly { maxInputBytes?: unknown }[],
  subjectBytes: number,
  fixedBytes: number,
): number {
  const parts = models.reduce((total, model) => total + advisorSubjectParts(model, subjectBytes, fixedBytes), 0);
  return Math.min(256 * 1024 * 1024, 1_000_000 + Math.max(1, parts) * 2_000_000 * 4);
}

export interface PromptFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  title: string;
  location?: string;
  evidence?: string;
  by?: string;
}

/** Paid findings remain in the artifact; only the model-facing aggregate is bounded. */
export function boundedFindings(findings: readonly PromptFinding[], artifactPath: string, budgetBytes = 40_000): string {
  const ranks = { blocker: 0, major: 1, minor: 2, nit: 3 };
  const lines = [`Full findings (${findings.length}), including any omitted evidence: ${artifactPath}`];
  for (const finding of [...findings].sort((a, b) => ranks[a.severity] - ranks[b.severity])) {
    const line = `- [${finding.severity}] ${finding.title.slice(0, 500)}${finding.location ? ` @ ${finding.location.slice(0, 1_000)}` : ''}${finding.by ? ` (raised by ${finding.by})` : ''}${finding.evidence ? ` — ${finding.evidence.slice(0, 600)}` : ''}`;
    if (promptBytes([...lines, line, 'Additional findings/evidence are in the full findings artifact.'].join('\n')) > budgetBytes) {
      lines.push('Additional findings/evidence are in the full findings artifact.');
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function promptBytes(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

export function promptBudgetError(
  prompt: string,
  budgetBytes = HARNESS_PROMPT_BUDGET_BYTES,
): string | null {
  const bytes = promptBytes(prompt);
  return bytes <= budgetBytes
    ? null
    : `phase prompt is ${bytes} bytes, exceeding the ${budgetBytes}-byte input budget ` +
        `(${HARNESS_OUTPUT_RESERVE_BYTES} bytes are reserved for model output); move large context to an artifact and retry`;
}

/** Bounded rendering for durable/user-authored context from an older ledger.
 * The full value remains in the ledger; only the model-facing excerpt is
 * shortened, with an explicit marker instead of silent loss. */
export function promptExcerpt(value: string, maxChars = 20_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… [model-facing excerpt truncated; full text is preserved in the harness ledger]`;
}
