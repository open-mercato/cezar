import { describe, expect, it } from 'vitest';

import {
  parseAskMarker,
  parseAskMarkerResult,
  parseAskRequest,
  stripAskMarker,
  type AskRequest,
} from './ask.ts';

const valid: AskRequest = {
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
};

describe('parseAskRequest', () => {
  it('accepts a well-formed single-question request', () => {
    expect(parseAskRequest(valid)).toEqual(valid);
  });

  it('accepts up to 4 questions with multiSelect and optional descriptions', () => {
    const req = {
      questions: [
        {
          id: 'q1',
          header: 'Sections',
          question: 'Which sections?',
          multiSelect: true,
          options: [{ label: 'Profile' }, { label: 'Billing' }],
        },
        {
          header: 'Theme',
          question: 'Which theme?',
          options: [{ label: 'Light' }, { label: 'Dark' }, { label: 'System' }],
        },
      ],
    };
    expect(parseAskRequest(req)).toEqual(req);
  });

  it('rejects an empty questions array', () => {
    expect(parseAskRequest({ questions: [] })).toBeNull();
  });

  it('rejects more than 4 questions', () => {
    const q = valid.questions[0];
    expect(parseAskRequest({ questions: [q, q, q, q, q] })).toBeNull();
  });

  it('rejects a question with fewer than 2 options', () => {
    expect(
      parseAskRequest({
        questions: [{ header: 'H', question: 'Q?', options: [{ label: 'only' }] }],
      }),
    ).toBeNull();
  });

  it('rejects a question with more than 4 options', () => {
    expect(
      parseAskRequest({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }],
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects a header longer than 12 chars', () => {
    expect(
      parseAskRequest({
        questions: [
          { header: 'thirteen char', question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-unique option labels within a question', () => {
    expect(
      parseAskRequest({
        questions: [
          { header: 'H', question: 'Q?', options: [{ label: 'same' }, { label: 'same' }] },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-unique question texts', () => {
    const q = valid.questions[0];
    expect(parseAskRequest({ questions: [q, { ...q }] })).toBeNull();
  });

  it('rejects unknown top-level and per-option keys (strict)', () => {
    expect(parseAskRequest({ questions: valid.questions, extra: 1 })).toBeNull();
    expect(
      parseAskRequest({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [
              { label: 'a', color: 'red' },
              { label: 'b' },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseAskRequest(null)).toBeNull();
    expect(parseAskRequest('CEZ:ASK')).toBeNull();
    expect(parseAskRequest(42)).toBeNull();
  });
});

const askJson = JSON.stringify(valid);

describe('parseAskMarker', () => {
  it('extracts a valid request from a trailing CEZ:ASK marker', () => {
    const turn = `Here are the options.\nCEZ:ASK ${askJson}`;
    expect(parseAskMarker(turn)).toEqual(valid);
  });

  it('tolerates trailing whitespace/newlines after the JSON', () => {
    expect(parseAskMarker(`text\nCEZ:ASK ${askJson}\n  \n`)).toEqual(valid);
  });

  it('returns null when there is no marker', () => {
    expect(parseAskMarker('just a normal answer, no marker')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseAskMarker('CEZ:ASK {not json')).toBeNull();
  });

  it('returns null when the JSON is valid but fails the schema', () => {
    expect(parseAskMarker('CEZ:ASK {"questions":[]}')).toBeNull();
  });

  it('normalizes bounded presentation drift without changing the choices', () => {
    const description = 'd'.repeat(300);
    const payload = {
      transportHint: 'render as chips',
      questions: [
        {
          header: 'Implementation path',
          question: 'Which implementation should I use?',
          multiSelect: false,
          presentation: 'compact',
          options: [
            { label: 'Minimal', description, recommended: true },
            { label: 'Expanded', description: 'Touch the wider surface' },
          ],
        },
      ],
    };
    const result = parseAskMarkerResult(`CEZ:ASK ${JSON.stringify(payload)}`);
    expect(result).toMatchObject({
      kind: 'valid',
      normalized: true,
      request: {
        questions: [
          {
            header: 'Implementati',
            question: 'Which implementation should I use?',
            options: [
              { label: 'Minimal', description: 'd'.repeat(280) },
              { label: 'Expanded', description: 'Touch the wider surface' },
            ],
          },
        ],
      },
    });
  });

  it('ignores a marker that is not at the end of the turn', () => {
    expect(parseAskMarker(`CEZ:ASK ${askJson}\nand then more text after`)).toBeNull();
  });
});

describe('parseAskMarkerResult diagnostics', () => {
  it('distinguishes ordinary prose from malformed JSON', () => {
    expect(parseAskMarkerResult('ordinary prose')).toEqual({ kind: 'none' });
    expect(parseAskMarkerResult('CEZ:ASK {not json')).toMatchObject({ kind: 'invalid-json' });
  });

  it('reports the zod path for a hard structural failure', () => {
    const result = parseAskMarkerResult('CEZ:ASK {"questions":[]}');
    expect(result).toMatchObject({ kind: 'invalid-structure' });
    if (result.kind === 'invalid-structure') expect(result.issues[0]?.path).toEqual(['questions']);
  });

  it('never drops options to force an over-cap request to validate', () => {
    const payload = {
      questions: [
        {
          header: 'Choice',
          question: 'Which?',
          options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })),
        },
      ],
    };
    expect(parseAskMarkerResult(`CEZ:ASK ${JSON.stringify(payload)}`)).toMatchObject({
      kind: 'invalid-structure',
    });
  });
});

// #936 — the single most common way an agent mangles a hand-written one-line
// JSON blob is dropping a trailing closer (or being cut off by an output-token
// limit). That used to die at `JSON.parse` and throw away a fully-formed card.
// A bounded closer repair sits under the schema: it appends the missing `}`/`]`
// and re-parses, but refuses anything that is not ONLY missing closers.
describe('parseAskMarkerResult — bounded closer repair (#936)', () => {
  // Verbatim from the issue: valid in every field, one `}` short of parsing.
  const truncated =
    'CEZ:ASK {"questions":[{"header":"Lint scope","question":"#95 is an issue, so there is nothing to merge on it directly. How much of the lint backlog should I do and land now?","multiSelect":false,"options":[{"label":"First slice only","description":"The 4 inline-JSX strings (likely untranslated text AGENTS.md forbids) plus the 4 i18next import warnings. One small, reviewable PR I can land today."},{"label":"Rule by rule","description":"A series of PRs, one rule group at a time, lowering the cap as each goes green. Slowest, but each behaviour change stays legible in review."},{"label":"Whole backlog","description":"All 101 to zero and the rules promoted back to error in one PR. Touches ~50 files of working code; highest risk of a silent behaviour change."}]}]';

  it('recovers the real payload that was one closing brace short', () => {
    const result = parseAskMarkerResult(truncated);
    expect(result).toMatchObject({ kind: 'valid', normalized: false, repaired: true });
    if (result.kind !== 'valid') return;
    expect(result.request.questions).toHaveLength(1);
    expect(result.request.questions[0]!.header).toBe('Lint scope');
    expect(result.request.questions[0]!.options.map((o) => o.label)).toEqual([
      'First slice only',
      'Rule by rule',
      'Whole backlog',
    ]);
  });

  it('repairs several missing closers at once, innermost first', () => {
    const result = parseAskMarkerResult(
      'CEZ:ASK {"questions":[{"header":"H","question":"Q?","options":[{"label":"a"},{"label":"b"}',
    );
    expect(result).toMatchObject({ kind: 'valid', repaired: true });
  });

  it('marks an already-valid payload as not repaired (identical path to before)', () => {
    expect(parseAskMarkerResult(`CEZ:ASK ${askJson}`)).toMatchObject({
      kind: 'valid',
      normalized: false,
      repaired: false,
    });
  });

  // The guards. Each of these is a stream that lost more than its closers, so
  // repairing it would invent a question the agent never finished asking.
  it('refuses a payload cut mid-string', () => {
    expect(
      parseAskMarkerResult(
        'CEZ:ASK {"questions":[{"header":"H","question":"Q?","options":[{"label":"a"},{"label":"b',
      ),
    ).toMatchObject({ kind: 'invalid-json' });
  });

  it('refuses a payload that ends after a comma or a colon', () => {
    expect(
      parseAskMarkerResult('CEZ:ASK {"questions":[{"header":"H","question":"Q?"},'),
    ).toMatchObject({ kind: 'invalid-json' });
    expect(parseAskMarkerResult('CEZ:ASK {"questions":')).toMatchObject({ kind: 'invalid-json' });
  });

  it('refuses a mismatched closer', () => {
    expect(
      parseAskMarkerResult('CEZ:ASK {"questions":[{"header":"H","question":"Q?","options":[}'),
    ).toMatchObject({ kind: 'invalid-json' });
  });

  it('refuses an already-balanced payload that fails to parse for another reason', () => {
    // A trailing comma — balanced, so there is nothing for the repair to add.
    expect(parseAskMarkerResult('CEZ:ASK {"questions":[],}')).toMatchObject({
      kind: 'invalid-json',
    });
  });

  it('refuses prose that merely happens to end in a closer', () => {
    expect(parseAskMarkerResult('CEZ:ASK see the options above }')).toMatchObject({
      kind: 'invalid-json',
    });
  });

  it('is not fooled by braces or escaped quotes inside string values', () => {
    const result = parseAskMarkerResult(
      'CEZ:ASK {"questions":[{"header":"H","question":"Use {a: 1} or \\"b\\"?","options":[{"label":"{a: 1}"},{"label":"\\"b\\""}]}]',
    );
    expect(result).toMatchObject({ kind: 'valid', repaired: true });
    if (result.kind === 'valid')
      expect(result.request.questions[0]!.options.map((o) => o.label)).toEqual(['{a: 1}', '"b"']);
  });

  // The repair fixes syntax only. The schema stays exactly as strict as it was:
  // a truncation that eats options past the 2-option minimum still degrades.
  it('still rejects a repaired payload that fails the schema', () => {
    expect(
      parseAskMarkerResult('CEZ:ASK {"questions":[{"header":"H","question":"Q?","options":[]'),
    ).toMatchObject({ kind: 'invalid-structure' });
  });

  it('still normalizes presentation drift in a repaired payload', () => {
    const result = parseAskMarkerResult(
      'CEZ:ASK {"questions":[{"header":"thirteen char","question":"Q?","options":[{"label":"a"},{"label":"b"}]}]',
    );
    expect(result).toMatchObject({ kind: 'valid', normalized: true, repaired: true });
    if (result.kind === 'valid') expect(result.request.questions[0]!.header).toBe('thirteen cha');
  });
});

describe('stripAskMarker', () => {
  it('removes a trailing CEZ:ASK marker for display', () => {
    expect(stripAskMarker(`Pick one.\nCEZ:ASK ${askJson}`)).toBe('Pick one.');
  });

  it('leaves text without a marker untouched', () => {
    expect(stripAskMarker('no marker here')).toBe('no marker here');
  });

  // Regression (blank-question bug): an invalid payload never becomes an ask
  // card, so stripping it would delete the agent's question from the transcript
  // with nothing to replace it. Invalid → text left intact (spec
  // 2026-07-18-askuser-across-runners: "invalid JSON / schema → null, text left
  // intact").
  it('keeps a marker whose JSON is valid but fails the schema (no card will render it)', () => {
    const invalid = 'Pick one.\nCEZ:ASK {"questions":[]}';
    expect(stripAskMarker(invalid)).toBe(invalid);
  });

  it('strips a marker after safely clipping an over-length presentation header', () => {
    const nearValid =
      'Zanim pójdziemy dalej:\nCEZ:ASK ' +
      JSON.stringify({
        questions: [
          {
            header: 'thirteen char', // 13 chars > the 12-char cap
            question: 'Który wariant?',
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      });
    expect(stripAskMarker(nearValid)).toBe('Zanim pójdziemy dalej:');
  });

  it('keeps a marker whose payload is not valid JSON at all', () => {
    const invalid = 'Pick one.\nCEZ:ASK {"questions": [}';
    expect(stripAskMarker(invalid)).toBe(invalid);
  });

  // #936 — a repaired payload renders a card, so its raw marker must go with
  // it. The old regex required a trailing `}`; a payload missing that brace
  // ends on `]` and would have left ~760 characters of JSON under the card.
  it('strips a marker whose payload was repaired and ends on a bracket', () => {
    const repaired =
      'Pick one.\nCEZ:ASK {"questions":[{"header":"H","question":"Q?","options":[{"label":"a"},{"label":"b"}]}]';
    expect(parseAskMarker(repaired)).not.toBeNull();
    expect(stripAskMarker(repaired)).toBe('Pick one.');
  });

  it('keeps a marker whose payload lost more than its closers', () => {
    const cut = 'Pick one.\nCEZ:ASK {"questions":[{"header":"H","question":"Q?","options":[{"label":"a';
    expect(stripAskMarker(cut)).toBe(cut);
  });
});

// The marker is detected on the ASSEMBLED turn text, which is how it stays
// uniform across all three backends: claude emits assistant text as whole
// blocks, while codex and opencode stream it as deltas that can split the
// marker across many `text` events. run.ts accumulates `turnText += event.text`
// and parses the concatenation — so a marker chopped into arbitrary chunks
// (the codex/opencode case) still resolves. #473 cross-backend guarantee.
describe('parseAskMarker — backend-agnostic assembly (codex/opencode delta streaming)', () => {
  it('detects a marker even when the agent text arrived in many delta chunks', () => {
    const full = `Let me confirm the approach.\n\nCEZ:ASK ${askJson}`;
    // Emulate a delta backend: split into 7-char chunks and reassemble, as
    // run.ts does across successive v1 `text` events.
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));
    const assembled = chunks.join('');
    expect(chunks.length).toBeGreaterThan(1);
    expect(parseAskMarker(assembled)).toEqual(valid);
  });
});
