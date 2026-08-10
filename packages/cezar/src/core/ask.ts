/**
 * AskUser payload — the structured multiple-choice question an agent asks the
 * user, so the cockpit can render clickable option chips instead of the prose
 * fallback ("AskUserQuestion isn't available…"). See the spec
 * `.ai/specs/2026-07-18-askuser-across-runners.md`.
 *
 * The agent emits this as a `CEZ:ASK <compact-json>` control marker (a sibling
 * of `CEZ:DONE` / `CEZ:MONITORING`), parsed on the assembled turn text in
 * `src/workflows/run.ts` — uniform across claude, codex and opencode with no
 * per-backend mapper work. The shape is modeled 1:1 on Claude Code's built-in
 * `AskUserQuestion` (1–4 questions, 2–4 options each, `header` ≤12 chars,
 * unique question texts and unique option labels) so a native bridge can map
 * onto it later. A free-text "Other" is always available via the composer, so
 * it is never an explicit option.
 */
import { z } from 'zod';

export const askOptionSchema = z
  .object({
    label: z.string().min(1).max(60),
    description: z.string().max(280).optional(),
  })
  .strict();

export const askQuestionSchema = z
  .object({
    /** Stable key for the answer; defaults to the array index when omitted. */
    id: z.string().min(1).max(64).optional(),
    /** ≤12-char chip label (matches AskUserQuestion's `header`). */
    header: z.string().min(1).max(12),
    question: z.string().min(1).max(400),
    options: z
      .array(askOptionSchema)
      .min(2)
      .max(4)
      .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, {
        message: 'option labels must be unique within a question',
      }),
    multiSelect: z.boolean().optional(),
  })
  .strict();

export const askRequestSchema = z
  .object({
    questions: z
      .array(askQuestionSchema)
      .min(1)
      .max(4)
      .refine((qs) => new Set(qs.map((q) => q.question)).size === qs.length, {
        message: 'question texts must be unique',
      }),
  })
  .strict();

export type AskOption = z.infer<typeof askOptionSchema>;
export type AskQuestion = z.infer<typeof askQuestionSchema>;
export type AskRequest = z.infer<typeof askRequestSchema>;

export interface AskParseIssue {
  code: string;
  path: PropertyKey[];
  message: string;
}

/** The diagnostic parse result used at turn-end. The compatibility wrapper
 * below deliberately keeps returning `AskRequest | null`. */
export type AskMarkerParseResult =
  | { kind: 'none' }
  | { kind: 'invalid-json'; message: string }
  | { kind: 'invalid-structure'; issues: AskParseIssue[] }
  | { kind: 'valid'; request: AskRequest; normalized: boolean };

/**
 * Parse a value into a validated `AskRequest`, or `null` when it does not match
 * (bad counts, over-length header, non-unique labels/questions, extra keys).
 * Callers degrade to plain text on `null` — the feature never makes the prose
 * fallback worse.
 */
export function parseAskRequest(value: unknown): AskRequest | null {
  const parsed = askRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The AskUser control marker: a trailing `CEZ:ASK <compact-json>` line (a
 * sibling of `CEZ:DONE` / `CEZ:MONITORING`). Detected on the *assembled* turn
 * text so delta-streaming backends can't split it — uniform across all three
 * backends. The JSON is greedily captured from the first `{` after the keyword
 * to the last `}` at end-of-text.
 */
export const ASK_MARKER_RE = /CEZ:ASK[ \t]+(\{[\s\S]*\})\s*$/;

/** Looser than `ASK_MARKER_RE` so diagnostics can distinguish a malformed
 * trailing marker from ordinary assistant prose. */
const ASK_MARKER_CANDIDATE_RE = /CEZ:ASK[ \t]+([\s\S]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Recover only presentation drift that cannot change the user's available
 * choices. Unknown keys are discarded, and the display-only header and option
 * description are clipped to their documented bounds. Counts, required text,
 * types, and uniqueness remain schema-enforced; questions/options are never
 * dropped to manufacture validity.
 */
function normalizeAskRequest(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const request: Record<string, unknown> = {};
  if (!hasOwn(value, 'questions')) return request;
  request.questions = Array.isArray(value.questions)
    ? value.questions.map((question) => {
        if (!isRecord(question)) return question;
        const normalized: Record<string, unknown> = {};
        for (const key of ['id', 'question', 'multiSelect'] as const) {
          if (hasOwn(question, key)) normalized[key] = question[key];
        }
        if (hasOwn(question, 'header')) {
          normalized.header =
            typeof question.header === 'string' ? question.header.slice(0, 12) : question.header;
        }
        if (hasOwn(question, 'options')) {
          normalized.options = Array.isArray(question.options)
            ? question.options.map((option) => {
                if (!isRecord(option)) return option;
                const next: Record<string, unknown> = {};
                if (hasOwn(option, 'label')) next.label = option.label;
                if (hasOwn(option, 'description')) {
                  next.description =
                    typeof option.description === 'string'
                      ? option.description.slice(0, 280)
                      : option.description;
                }
                return next;
              })
            : question.options;
        }
        return normalized;
      })
    : value.questions;
  return request;
}

function issuesOf(error: z.ZodError): AskParseIssue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
  }));
}

/**
 * Parse a trailing marker with an actionable result for diagnostics. A
 * parseable near-valid request gets one bounded normalization pass; structural
 * violations remain rejected so the raw fallback stays readable.
 */
export function parseAskMarkerResult(turnText: string): AskMarkerParseResult {
  const match = ASK_MARKER_CANDIDATE_RE.exec(turnText.trimEnd());
  if (!match || match[1] === undefined) return { kind: 'none' };
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    return {
      kind: 'invalid-json',
      message: error instanceof Error ? error.message : 'invalid JSON',
    };
  }

  const strict = askRequestSchema.safeParse(raw);
  if (strict.success) return { kind: 'valid', request: strict.data, normalized: false };

  const normalized = askRequestSchema.safeParse(normalizeAskRequest(raw));
  if (normalized.success) return { kind: 'valid', request: normalized.data, normalized: true };
  return { kind: 'invalid-structure', issues: issuesOf(normalized.error) };
}

/**
 * Extract and validate a trailing `CEZ:ASK <json>` marker from assembled turn
 * text. Returns a strict or safely normalized `AskRequest`, or `null` when
 * there is no marker or its payload remains invalid (caller degrades to plain
 * text — the prose fallback is never made worse).
 */
export function parseAskMarker(turnText: string): AskRequest | null {
  const parsed = parseAskMarkerResult(turnText);
  return parsed.kind === 'valid' ? parsed.request : null;
}

/**
 * Strip a trailing `CEZ:ASK <json>` marker from one text event so transcripts
 * stay free of protocol noise — but ONLY when the payload actually validates.
 * An invalid payload never becomes an ask card (`parseAskMarker` → `null`), so
 * stripping it would delete the agent's question from the transcript with
 * nothing to replace it; it stays visible as raw text instead — degraded but
 * answerable (the prose fallback is never made worse). Delta backends may split
 * the marker across events — then it stays visible; detection on the assembled
 * turn text is unaffected (same best-effort caveat as the `CEZ:DONE` /
 * `CEZ:MONITORING` strippers).
 */
export function stripAskMarker(text: string): string {
  if (parseAskMarker(text) === null) return text;
  return text.replace(/\s*CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/, '');
}
