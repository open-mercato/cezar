import { describe, expect, it } from 'vitest';
import {
  REPORT_MARKER_RE,
  SPAWN_MARKER_RE,
  parseReportMarkerResult,
  parseSpawnMarkerResult,
  stripReportMarker,
  stripSpawnMarker,
} from './markers.ts';

/**
 * The `CEZ:SPAWN` / `CEZ:REPORT` marker parsers (spec 2026-09-08-units-hierarchy §Markers).
 *
 * The cases mirror `core/ask.test.ts`'s, because the parsers mirror `core/ask.ts`: a valid
 * payload, a malformed one, a structurally wrong one, the missing-closers repair (#936), and the
 * overwhelmingly common absent case. The one behaviour that deliberately DIFFERS from the ask
 * card is normalization — there is none here: an unknown key on a spawn is a rejected payload,
 * not a trimmed one, because a misspelled `max_cost` that is silently dropped is a budget brake
 * that never fires.
 */

const CHILD = { title: 'Wire the store', objective: 'Add the unit field to the run store.' };
const spawn = (payload: unknown) => `Planning done.\n\nCEZ:SPAWN ${JSON.stringify(payload)}`;
const report = (payload: unknown) => `All finished.\n\nCEZ:REPORT ${JSON.stringify(payload)}`;

const VALID_REPORT = {
  status: 'done',
  result: 'Added the field and the parity test passes.',
  evidence: ['npm test -- store.test.ts → 12 passed'],
};

describe('CEZ:SPAWN', () => {
  it('parses a minimal valid payload', () => {
    const parsed = parseSpawnMarkerResult(spawn({ children: [CHILD] }));
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') return;
    expect(parsed.payload.children).toHaveLength(1);
    expect(parsed.payload.children[0]).toEqual(CHILD);
    expect(parsed.repaired).toBe(false);
  });

  it('parses the full task order, keeping every optional key', () => {
    const child = {
      ...CHILD,
      scope: 'packages/cezar/src/runs/**',
      allowed_tools: ['Read', 'Edit'],
      max_cost: 2.5,
      success_criteria: 'npm test is green',
      required_evidence: 'the test output',
      retry_limit: 1,
    };
    const parsed = parseSpawnMarkerResult(spawn({ children: [child] }));
    expect(parsed.kind === 'valid' && parsed.payload.children[0]).toEqual(child);
  });

  it('accepts four children and refuses a fifth — the in-flight cap is in the schema', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ ...CHILD, title: `Child ${i}` }));
    expect(parseSpawnMarkerResult(spawn({ children: four })).kind).toBe('valid');
    const five = [...four, { ...CHILD, title: 'Child 5' }];
    const parsed = parseSpawnMarkerResult(spawn({ children: five }));
    expect(parsed.kind).toBe('invalid-structure');
    if (parsed.kind !== 'invalid-structure') return;
    expect(parsed.issues.some((issue) => issue.path.includes('children'))).toBe(true);
  });

  it('refuses an empty children array — a spawn that spawns nothing is a mistake, not a no-op', () => {
    expect(parseSpawnMarkerResult(spawn({ children: [] })).kind).toBe('invalid-structure');
  });

  it('refuses an unknown key rather than trimming it', () => {
    // The regression this strictness exists for: `max_costs` silently dropped is an uncapped run.
    const parsed = parseSpawnMarkerResult(spawn({ children: [{ ...CHILD, max_costs: 2 }] }));
    expect(parsed.kind).toBe('invalid-structure');
  });

  it('refuses an unknown key at the top level too', () => {
    expect(parseSpawnMarkerResult(spawn({ children: [CHILD], budget: 5 })).kind).toBe('invalid-structure');
  });

  it('refuses an over-long title and a fractional retry_limit', () => {
    expect(parseSpawnMarkerResult(spawn({ children: [{ ...CHILD, title: 'x'.repeat(121) }] })).kind)
      .toBe('invalid-structure');
    expect(parseSpawnMarkerResult(spawn({ children: [{ ...CHILD, retry_limit: 1.5 }] })).kind)
      .toBe('invalid-structure');
  });

  it('reports malformed JSON as invalid-json, not as absent', () => {
    const parsed = parseSpawnMarkerResult('CEZ:SPAWN {"children": [,]}');
    expect(parsed.kind).toBe('invalid-json');
  });

  it('recovers a payload that is only missing its closing brackets (#936)', () => {
    const whole = JSON.stringify({ children: [CHILD] });
    const truncated = whole.slice(0, whole.lastIndexOf(']'));
    const parsed = parseSpawnMarkerResult(`CEZ:SPAWN ${truncated}`);
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') return;
    expect(parsed.repaired).toBe(true);
    expect(parsed.payload.children[0]).toEqual(CHILD);
  });

  it('does not recover a stream cut mid-string — that is a truncation, not a missing closer', () => {
    expect(parseSpawnMarkerResult('CEZ:SPAWN {"children":[{"title":"half a ti').kind).toBe('invalid-json');
  });

  it('is absent from ordinary prose', () => {
    expect(parseSpawnMarkerResult('I considered delegating this.')).toEqual({ kind: 'none' });
  });

  it('diagnoses prose that trails the keyword rather than silently ignoring it', () => {
    // `ask.ts`'s exact behaviour, mirrored on purpose: the looser candidate regex is what lets a
    // turn-end handler say "you meant to spawn and the payload was unreadable" instead of
    // treating a botched marker as an ordinary end of turn.
    expect(parseSpawnMarkerResult('I will use CEZ:SPAWN once I have read the code.').kind)
      .toBe('invalid-json');
  });

  it('only matches at the END of the turn — a marker with prose after it is not a marker', () => {
    const text = `${spawn({ children: [CHILD] })}\n\nAnd now some more thinking.`;
    expect(SPAWN_MARKER_RE.test(text)).toBe(false);
    // The candidate regex still sees it, so the payload is diagnosed rather than silently missed.
    expect(parseSpawnMarkerResult(text).kind).toBe('invalid-json');
  });

  describe('stripping', () => {
    it('removes a valid marker from the displayed text', () => {
      expect(stripSpawnMarker(spawn({ children: [CHILD] }))).toBe('Planning done.');
    });

    it('leaves an INVALID marker visible — the transcript is the only record of what was tried', () => {
      const text = spawn({ children: [] });
      expect(stripSpawnMarker(text)).toBe(text);
    });

    it('leaves text with no marker untouched', () => {
      expect(stripSpawnMarker('nothing to see')).toBe('nothing to see');
    });
  });
});

describe('CEZ:REPORT', () => {
  it('parses a valid report and fills the array defaults', () => {
    const parsed = parseReportMarkerResult(report(VALID_REPORT));
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') return;
    expect(parsed.payload.status).toBe('done');
    expect(parsed.payload.evidence).toEqual(VALID_REPORT.evidence);
    // Absent on the wire, filled on parse — so a renderer never branches on "the model omitted it".
    expect(parsed.payload.side_effects).toEqual([]);
    expect(parsed.payload.errors).toEqual([]);
  });

  it.each(['done', 'partial', 'failed', 'blocked'] as const)('accepts status %s', (status) => {
    expect(parseReportMarkerResult(report({ ...VALID_REPORT, status })).kind).toBe('valid');
  });

  it('refuses a status the engine has no branch for', () => {
    expect(parseReportMarkerResult(report({ ...VALID_REPORT, status: 'mostly' })).kind)
      .toBe('invalid-structure');
  });

  it('refuses a missing result and an out-of-range confidence', () => {
    expect(parseReportMarkerResult(report({ status: 'done' })).kind).toBe('invalid-structure');
    expect(parseReportMarkerResult(report({ ...VALID_REPORT, confidence: 1.5 })).kind)
      .toBe('invalid-structure');
  });

  it('refuses more than 12 evidence lines', () => {
    const evidence = Array.from({ length: 13 }, (_, i) => `line ${i}`);
    expect(parseReportMarkerResult(report({ ...VALID_REPORT, evidence })).kind).toBe('invalid-structure');
  });

  it('reports malformed JSON as invalid-json', () => {
    expect(parseReportMarkerResult('CEZ:REPORT {status: done}').kind).toBe('invalid-json');
  });

  it('recovers a report missing its closing brace', () => {
    const whole = JSON.stringify(VALID_REPORT);
    const parsed = parseReportMarkerResult(`CEZ:REPORT ${whole.slice(0, whole.lastIndexOf('}'))}`);
    expect(parsed.kind === 'valid' && parsed.repaired).toBe(true);
  });

  it('is absent from ordinary prose', () => {
    expect(parseReportMarkerResult('Here is my report, in prose.')).toEqual({ kind: 'none' });
  });

  it('matches only a trailing marker', () => {
    expect(REPORT_MARKER_RE.test(report(VALID_REPORT))).toBe(true);
    expect(REPORT_MARKER_RE.test(`${report(VALID_REPORT)}\nmore text`)).toBe(false);
  });

  describe('stripping', () => {
    it('removes a valid marker', () => {
      expect(stripReportMarker(report(VALID_REPORT))).toBe('All finished.');
    });

    it('leaves an invalid one visible', () => {
      const text = report({ status: 'done' });
      expect(stripReportMarker(text)).toBe(text);
    });
  });
});
