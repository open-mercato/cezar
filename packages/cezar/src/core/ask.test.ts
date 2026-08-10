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
