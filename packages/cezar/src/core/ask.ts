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

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Coerce a nearly-valid payload into a valid one.
 *
 * Models overrun the cosmetic limits routinely — a 15-character `header` where
 * the contract says 12 is by far the most common — and the schema is
 * all-or-nothing, so one long chip label cost the user the entire card and put
 * a wall of raw JSON in the transcript instead. Nothing repaired here changes
 * what is being asked: chip labels and descriptions are truncated, unknown keys
 * dropped, colliding option labels disambiguated.
 *
 * Structural problems are deliberately NOT repaired. Fewer than two options is
 * not a choice, and more questions or options than the card can show would have
 * to be dropped to fit — silently discarding a real alternative is worse than
 * the prose fallback that handles those (`formatAskAsProse`).
 */
export function repairAskRequest(value: unknown): AskRequest | null {
  const direct = parseAskRequest(value);
  if (direct) return direct;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return null;
  const repaired = questions.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
    const question = entry as Record<string, unknown>;
    const options = Array.isArray(question.options) ? question.options : question.options;
    const taken = new Set<string>();
    return {
      ...(typeof question.id === 'string' ? { id: clamp(question.id, 64) } : {}),
      ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
      header: typeof question.header === 'string' ? clamp(question.header, 12) : question.header,
      question: typeof question.question === 'string' ? clamp(question.question, 400) : question.question,
      options: Array.isArray(options)
        ? options.map((raw) => {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
            const option = raw as Record<string, unknown>;
            if (typeof option.label !== 'string') return option;
            let label = clamp(option.label, 60);
            for (let n = 2; taken.has(label); n += 1) label = `${clamp(option.label, 56)} (${n})`;
            taken.add(label);
            return {
              label,
              ...(typeof option.description === 'string'
                ? { description: clamp(option.description, 280) }
                : {}),
            };
          })
        : options,
    };
  });
  return parseAskRequest({ questions: repaired });
}

/**
 * The questions rendered as prose, for a payload that cannot become a card at
 * all. Raw JSON in the transcript is technically "no worse than no card", but
 * in practice it is a screenful of braces where a question should be, and the
 * user cannot answer what they cannot read. Returns `null` when the value is
 * not ask-shaped enough to be worth rewriting.
 */
export function formatAskAsProse(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const blocks: string[] = [];
  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const question = entry as Record<string, unknown>;
    const text = typeof question.question === 'string' ? question.question.trim() : '';
    if (!text) continue;
    const header = typeof question.header === 'string' ? question.header.trim() : '';
    const lines = [header ? `**${header}** — ${text}` : `**${text}**`];
    const options = Array.isArray(question.options) ? question.options : [];
    for (const raw of options) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const option = raw as Record<string, unknown>;
      const label = typeof option.label === 'string' ? option.label.trim() : '';
      if (!label) continue;
      const description =
        typeof option.description === 'string' ? option.description.trim() : '';
      lines.push(description ? `- ${label} — ${description}` : `- ${label}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Extract and validate a trailing `CEZ:ASK <json>` marker from assembled turn
 * text. Returns the `AskRequest` — repaired where the payload only broke a
 * cosmetic limit — or `null` when there is no marker or the payload is not
 * valid JSON / cannot be repaired into the schema.
 */
export function parseAskMarker(turnText: string): AskRequest | null {
  const match = ASK_MARKER_RE.exec(turnText.trimEnd());
  if (!match || match[1] === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return repairAskRequest(raw);
}

/**
 * Resolve a trailing `CEZ:ASK <json>` marker for display.
 *
 * Three outcomes, in order. A payload that becomes a card is removed — the card
 * is where the questions now live. A payload that cannot become a card but is
 * still ask-shaped is REWRITTEN as prose: it used to be left in place as raw
 * JSON, which is unreadable and unanswerable, and is what a single over-length
 * `header` used to produce. Anything else is left untouched, because deleting
 * it would remove the agent's question from the thread with nothing to replace
 * it.
 *
 * Delta backends may split the marker across events — then it stays visible;
 * detection on the assembled turn text is unaffected (same best-effort caveat
 * as the `CEZ:DONE` / `CEZ:MONITORING` strippers).
 */
export function stripAskMarker(text: string): string {
  const match = ASK_MARKER_RE.exec(text.trimEnd());
  if (!match || match[1] === undefined) return text;
  if (parseAskMarker(text) !== null) return text.replace(/\s*CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return text;
  }
  const prose = formatAskAsProse(raw);
  return prose === null ? text : text.replace(/CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/, prose);
}
