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
import {
  closeUnbalancedJson,
  lastMarkerCandidate,
  stripLastMarker,
  trimTrailingControlMarkers,
} from '../core/ask.ts';
import type { AskParseIssue } from '../core/ask.ts';

/** The strict marker shapes — a trailing `CEZ:SPAWN`/`CEZ:REPORT` whose payload runs from the
 *  first `{` to the last `}` at end-of-text. Exported for the engine's precedence check. */
export const SPAWN_MARKER_RE = /CEZ:SPAWN[ \t]+(\{[\s\S]*\})\s*$/;
export const REPORT_MARKER_RE = /CEZ:REPORT[ \t]+(\{[\s\S]*\})\s*$/;

/** The two keywords. The payload candidate is everything after the LAST occurrence of one
 *  (`lastMarkerCandidate`), so prose that merely mentions the keyword earlier in the turn cannot
 *  hijack the real marker line, and a trailing `CEZ:MONITORING`/`CEZ:DONE` line the role prompts
 *  ask for is trimmed before parsing. Same split `ask.ts` makes and for the same reason. */
const SPAWN_KEYWORD = 'CEZ:SPAWN';
const REPORT_KEYWORD = 'CEZ:REPORT';

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
  keyword: string,
  schema: S,
): UnitMarkerParseResult<z.infer<S>> {
  const candidate = lastMarkerCandidate(turnText.trimEnd(), keyword);
  if (candidate === null) return { kind: 'none' };
  const payload = trimTrailingControlMarkers(candidate);
  let raw: unknown;
  let repaired = false;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    const closed = closeUnbalancedJson(payload);
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
  return parseMarker(turnText, SPAWN_KEYWORD, unitSpawnSchema);
}

/**
 * Clip a report's strings and lists to the bounds `unitReportSchema` sets, so a report that is
 * only TOO LONG is accepted rather than refused.
 *
 * A report is a statement about work already done — unlike a spawn, no key in it is a brake, so
 * nothing is lost by shortening. Refusing it costs far more: observed live, an implementer wrote
 * one side-effect line of 500 characters, ended the same turn with CEZ:DONE, and settled with no
 * structured report at all — its commander then had to re-validate everything by hand. The clip
 * is reported as `repaired`, so the transcript still says the payload was not what the agent sent.
 */
function clipReport(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  const clipString = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : value);
  const clipList = (value: unknown, max: number, each: number) =>
    Array.isArray(value) ? value.slice(0, max).map((item) => clipString(item, each)) : value;
  return {
    ...source,
    result: clipString(source.result, 4000),
    evidence: clipList(source.evidence, 12, 400),
    side_effects: clipList(source.side_effects, 12, 400),
    errors: clipList(source.errors, 12, 400),
    suggestions: clipList(source.suggestions, 8, 400),
    recommended_next_action: clipString(source.recommended_next_action, 1000),
  };
}

/** Parse a trailing `CEZ:REPORT <json>` with an actionable result. A payload refused only for
 *  length is clipped to the schema's bounds and accepted as `repaired`. */
export function parseReportMarkerResult(turnText: string): UnitMarkerParseResult<UnitReport> {
  const strict = parseMarker(turnText, REPORT_KEYWORD, unitReportSchema);
  if (strict.kind !== 'invalid-structure') return strict;
  const candidate = lastMarkerCandidate(turnText.trimEnd(), REPORT_KEYWORD);
  if (candidate === null) return strict;
  let raw: unknown;
  try {
    raw = JSON.parse(trimTrailingControlMarkers(candidate));
  } catch {
    const closed = closeUnbalancedJson(trimTrailingControlMarkers(candidate));
    if (closed === null) return strict;
    try {
      raw = JSON.parse(closed);
    } catch {
      return strict;
    }
  }
  const clipped = unitReportSchema.safeParse(clipReport(raw));
  return clipped.success ? { kind: 'valid', payload: clipped.data, repaired: true } : strict;
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
  return stripLastMarker(text, SPAWN_KEYWORD);
}

export function stripReportMarker(text: string): string {
  if (parseReportMarker(text) === null) return text;
  return stripLastMarker(text, REPORT_KEYWORD);
}
