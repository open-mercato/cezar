/**
 * The two unit control markers — `CEZ:SPAWN <json>` and `CEZ:REPORT <json>` (spec
 * `.ai/specs/2026-09-08-units-hierarchy.md` §Markers).
 *
 * Modeled 1:1 on `src/core/ask.ts`, deliberately: the emission problem is identical (a model
 * hand-writing a long one-line JSON blob at the end of a turn, possibly split across delta
 * events), so the detection rules are identical too — matched on the ASSEMBLED turn text, the
 * JSON captured greedily from the first `{` after the keyword to the last `}` at end-of-text, and
 * the one syntax slip that actually happens (missing closers, #936) repaired by the SAME helper
 * `ask.ts` exports rather than a second copy of it.
 *
 * What is deliberately NOT copied is `ask.ts`'s normalization pass. That layer clips a
 * display-only `header` and drops unknown keys because doing so cannot change the user's
 * available choices. Neither is true here: a spawn's optional keys are the child's cost cap and
 * scope, and quietly discarding a misspelled `max_costs` would launch an uncapped run. So both
 * payloads go through their schema unmodified, and a violation is refused — which at the engine
 * is a transcript note, never a crash.
 *
 * Precedence at turn end is the engine's business, not this module's: `CEZ:DONE` > `CEZ:SPAWN` >
 * `CEZ:REPORT` > `CEZ:ASK` > `CEZ:MONITORING` > plain end.
 */
import type { z } from 'zod';
import type { UnitReport, UnitSpawn } from '@open-mercato/cezar-contract';
import { unitReportSchema, unitSpawnSchema } from '@open-mercato/cezar-contract';
import { closeUnbalancedJson } from '../core/ask.ts';
import type { AskParseIssue } from '../core/ask.ts';

/** The strict marker shapes — a trailing `CEZ:SPAWN`/`CEZ:REPORT` whose payload runs from the
 *  first `{` to the last `}` at end-of-text. Exported for the engine's precedence check. */
export const SPAWN_MARKER_RE = /CEZ:SPAWN[ \t]+(\{[\s\S]*\})\s*$/;
export const REPORT_MARKER_RE = /CEZ:REPORT[ \t]+(\{[\s\S]*\})\s*$/;

/** Looser twins, so diagnostics can tell a MALFORMED trailing marker from ordinary prose that
 *  merely mentions one. Same split `ask.ts` makes and for the same reason. */
const SPAWN_MARKER_CANDIDATE_RE = /CEZ:SPAWN[ \t]+([\s\S]*)$/;
const REPORT_MARKER_CANDIDATE_RE = /CEZ:REPORT[ \t]+([\s\S]*)$/;

/** One zod complaint, flattened. The same shape `parseAskMarkerResult` reports, so a turn-end
 *  handler can render any of the three markers' failures through one path. */
export type UnitMarkerParseIssue = AskParseIssue;

/**
 * The diagnostic parse result, shaped exactly like `AskMarkerParseResult`:
 * `none` (no marker — the overwhelmingly common case), `invalid-json`, `invalid-structure`
 * (parsed, but the schema refused it) or `valid`. `repaired` marks a payload that only parsed
 * because its missing closers were appended (#936) — the engine surfaces that as a note rather
 * than claiming a clean parse.
 */
export type UnitMarkerParseResult<T> =
  | { kind: 'none' }
  | { kind: 'invalid-json'; message: string }
  | { kind: 'invalid-structure'; issues: UnitMarkerParseIssue[] }
  | { kind: 'valid'; payload: T; repaired?: boolean };

function issuesOf(error: z.ZodError): UnitMarkerParseIssue[] {
  return error.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message }));
}

/** The shared body of both parsers. One implementation, two schemas — the markers differ only in
 *  their keyword and their payload shape, and two near-identical copies is exactly how one of
 *  them ends up with a repair layer the other lacks. */
function parseMarker<S extends z.ZodType>(
  turnText: string,
  candidate: RegExp,
  schema: S,
): UnitMarkerParseResult<z.infer<S>> {
  const match = candidate.exec(turnText.trimEnd());
  if (!match || match[1] === undefined) return { kind: 'none' };
  let raw: unknown;
  let repaired = false;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    const closed = closeUnbalancedJson(match[1]);
    try {
      if (closed === null) throw error;
      raw = JSON.parse(closed);
      repaired = true;
    } catch {
      return {
        kind: 'invalid-json',
        message: error instanceof Error ? error.message : 'invalid JSON',
      };
    }
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { kind: 'valid', payload: parsed.data, repaired };
  return { kind: 'invalid-structure', issues: issuesOf(parsed.error) };
}

/** Parse a trailing `CEZ:SPAWN <json>` with an actionable result. Unknown keys and a fifth child
 *  are `invalid-structure`, not a silent trim (`unitSpawnSchema` is `.strict()`). */
export function parseSpawnMarkerResult(turnText: string): UnitMarkerParseResult<UnitSpawn> {
  return parseMarker(turnText, SPAWN_MARKER_CANDIDATE_RE, unitSpawnSchema);
}

/** Parse a trailing `CEZ:REPORT <json>` with an actionable result. */
export function parseReportMarkerResult(turnText: string): UnitMarkerParseResult<UnitReport> {
  return parseMarker(turnText, REPORT_MARKER_CANDIDATE_RE, unitReportSchema);
}

/** The `parseAskMarker` twin: the payload, or `null` when there is no marker or it is invalid. */
export function parseSpawnMarker(turnText: string): UnitSpawn | null {
  const parsed = parseSpawnMarkerResult(turnText);
  return parsed.kind === 'valid' ? parsed.payload : null;
}

export function parseReportMarker(turnText: string): UnitReport | null {
  const parsed = parseReportMarkerResult(turnText);
  return parsed.kind === 'valid' ? parsed.payload : null;
}

/**
 * Strip a trailing marker from one text event so transcripts stay free of protocol noise — but
 * ONLY when the payload actually validates, exactly as `stripAskMarker` does.
 *
 * The rule is the same and so is the reason: an invalid payload never becomes a spawn or a
 * report, so stripping it would delete the agent's intent from the transcript with nothing to
 * replace it. It stays visible as raw text instead, next to the note explaining why it was
 * refused — which is also the only way the user can see WHAT the agent tried to do.
 *
 * The strip runs from the keyword to end-of-text rather than to a trailing `}`, because a
 * repaired payload ends before the closers this module appended.
 */
export function stripSpawnMarker(text: string): string {
  if (parseSpawnMarker(text) === null) return text;
  return text.replace(/\s*CEZ:SPAWN[ \t]+[\s\S]*$/, '');
}

export function stripReportMarker(text: string): string {
  if (parseReportMarker(text) === null) return text;
  return text.replace(/\s*CEZ:REPORT[ \t]+[\s\S]*$/, '');
}
