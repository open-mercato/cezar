import {
  ANALYZER_SYSTEM_PROMPT,
  RootCauseSchema,
  NoActionNeededSchema,
  AnalyzerResultSchema,
} from './analyzer.js';
import { FIXER_SYSTEM_PROMPT, FixReportSchema } from './fixer.js';
import { REVIEWER_SYSTEM_PROMPT, ReviewVerdictSchema } from './reviewer.js';
import { AGENT_EXECUTION_GUIDANCE } from './agent-guidance.js';

/**
 * Unified autofix system prompt — one system message playing the four
 * classical roles in sequence inside a single persistent `claude`
 * session.
 *
 * The user drives phase transitions by sending `## PHASE: <NAME>` user
 * messages over stream-json stdin. The model is told to wait for those
 * markers — it must not advance to the next role on its own.
 *
 * Token telemetry snapshots usage at each phase boundary; per-phase JSON
 * validation is warn-only. Both are implemented by the runner, not the
 * model — this prompt just tells it what the expected shapes are.
 */
export const UNIFIED_AUTOFIX_SYSTEM_PROMPT = `You are the Cezar AUTOFIX agent. Across this conversation you will play four roles in sequence.

## How phase transitions work

The user will mark the start of each phase with a single line beginning with "## PHASE: <NAME>". When you see one:

  1. Switch to that role.
  2. Use only the tools appropriate for that role (verify and analyzer are read-only; fixer may edit; reviewer is read-only).
  3. End your turn with a single JSON object matching that phase's schema (below) — no markdown fences, no prose before or after.
  4. STOP. Do not begin the next phase on your own. Wait for the user's next "## PHASE:" marker.

The four phases, in order: VERIFY-IN-REPO → ANALYZER → FIXER → REVIEWER. The user may also send a "## PHASE: RETRY-FIXER" with prior reviewer notes if the first fix attempt failed review.

## Phase 1: VERIFY-IN-REPO

${verifyBody()}

## Phase 2: ANALYZER

${ANALYZER_SYSTEM_PROMPT.replace(/^You are the ANALYZER agent\.[^\n]*\n+/i, '')
  .replace(new RegExp(escape(AGENT_EXECUTION_GUIDANCE) + '$'), '')
  .trim()}

## Phase 3: FIXER

${FIXER_SYSTEM_PROMPT.replace(/^You are the FIXER agent\.[^\n]*\n+/i, '')
  .replace(new RegExp(escape(AGENT_EXECUTION_GUIDANCE) + '$'), '')
  .trim()}

## Phase 4: REVIEWER

${REVIEWER_SYSTEM_PROMPT.replace(/^You are the REVIEWER agent\.[^\n]*\n+/i, '')
  .replace(new RegExp(escape(AGENT_EXECUTION_GUIDANCE) + '$'), '')
  .trim()}

${AGENT_EXECUTION_GUIDANCE}`;

/**
 * Schemas keyed by phase name. The persistent-session runner uses these
 * for the warn-only validation in §7 Q6 — schema mismatches emit a
 * `note` event but never halt the run.
 */
export const PHASE_SCHEMAS = {
  'verify-in-repo': null, // verify schema lives in the workflow def; not exported here
  analyzer: AnalyzerResultSchema,
  fixer: FixReportSchema,
  reviewer: ReviewVerdictSchema,
} as const;

/** The four canonical phase markers, in order. */
export const PHASES = ['verify-in-repo', 'analyzer', 'fixer', 'reviewer'] as const;
export type PhaseName = (typeof PHASES)[number];

/** Format a user-facing phase marker the model recognises. */
export function phaseMarker(phase: PhaseName, payload: string): string {
  return `## PHASE: ${phase.toUpperCase()}\n\n${payload}`;
}

/**
 * Build a unified system prompt for a generic (user-defined) flow workflow
 * — same shape as `UNIFIED_AUTOFIX_SYSTEM_PROMPT`, but with N user-chosen
 * phases instead of the four hard-coded autofix roles.
 *
 * The caller is responsible for resolving each step's body (built-in step
 * prompt + repo skill body, however the engine usually composes it) and
 * passing it in pre-rendered as `phases[i].body`. Phase ids are the step
 * ids the engine drives — the `## PHASE: <id>` markers must match those
 * verbatim so `PersistentClaudeSession.sendPhase(step.id, …)` lands in
 * the right place.
 */
export function buildUnifiedFlowSystemPrompt(args: {
  workflowId: string;
  phases: Array<{ id: string; body: string }>;
}): string {
  const { workflowId, phases } = args;
  if (phases.length === 0) {
    throw new Error(`buildUnifiedFlowSystemPrompt: '${workflowId}' has zero agent phases`);
  }
  const order = phases.map((p) => p.id.toUpperCase()).join(' → ');
  const intro = `You are an agent executing the '${workflowId}' workflow as a single persistent session. Across this conversation you will play ${phases.length} role(s) in sequence.

## How phase transitions work

The user will mark the start of each phase with a single line beginning with "## PHASE: <NAME>". When you see one:

  1. Switch to that phase's role (instructions below).
  2. Use only the tools appropriate for that phase.
  3. End your turn with the output the phase calls for (plain text, or JSON when the phase explicitly asks for it).
  4. STOP. Do not begin the next phase on your own. Wait for the user's next "## PHASE:" marker.

The phases, in order: ${order}.`;

  const sections = phases
    .map((p, i) => `## Phase ${i + 1}: ${p.id.toUpperCase()}\n\n${p.body.trim()}`)
    .join('\n\n');

  return `${intro}\n\n${sections}\n\n${AGENT_EXECUTION_GUIDANCE}`;
}

// ─────────────────────────────────────────────────────────────────────
// helpers — exported so tests can poke at them
// ─────────────────────────────────────────────────────────────────────

function verifyBody(): string {
  // VERIFY's prompt lives inline in autofix.workflow.ts today; copy the
  // body verbatim so the unified prompt stays semantically identical.
  return `Confirm the reported issue is a *real, still-unfixed defect* — as opposed to expected behavior, an issue that is already fixed on this branch, or something that is not actually a bug.

RULES:
- You have READ-ONLY tools (Read, Grep, Glob, and read-only Bash like \`git log\`, \`git diff\`, \`git show\`, \`git status\`).
- Do NOT edit any files.
- Be quick: this is a triage gate, not a full root-cause analysis. Stop as soon as you can defend a yes/no.
- Look for: a recent commit that already fixed it; a test that already covers it; documented/intentional behavior; an environment/usage error on the reporter's side.

OUTPUT — output ONLY a single JSON object (no markdown fences, no prose):
{
  "isRealUnfixedDefect": true | false,
  "reason": "one short paragraph. Cite commit hashes, file paths, or test names as evidence.",
  "confidence": 0.0 to 1.0
}`;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Re-exports for convenience.
export {
  RootCauseSchema,
  NoActionNeededSchema,
  AnalyzerResultSchema,
  FixReportSchema,
  ReviewVerdictSchema,
};
