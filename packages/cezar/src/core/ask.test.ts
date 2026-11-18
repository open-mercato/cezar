import { describe, expect, it } from 'vitest';

import {
  ASK_MAX_OPTIONS,
  parseAskCloseMarkers,
  stripAskCloseMarkers,
  ASK_MAX_QUESTIONS,
  askVisibleText,
  parseAskMarker,
  parseAskMarkerResult,
  parseAskRequest,
  stripAskMarker,
  type AskQuestion,
  type AskRequest,
} from './ask.ts';

/** A distinct, well-formed question — so a count test can only fail on the count. */
function question(index: number): AskQuestion {
  return {
    header: `H${index}`,
    question: `Question ${index}?`,
    options: [{ label: 'yes' }, { label: 'no' }],
  };
}

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

  it('accepts several questions with multiSelect and optional descriptions', () => {
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

  // The cap used to be 4, for parity with AskUserQuestion. A live run lost its question to
  // that: five legitimate decisions, whole payload refused, raw JSON shown to the user.
  it('accepts the five-question card the old cap refused', () => {
    const req = { questions: Array.from({ length: 5 }, (_, i) => question(i)) };
    expect(parseAskRequest(req)).toEqual(req);
  });

  it('accepts a card at exactly ASK_MAX_QUESTIONS', () => {
    const req = { questions: Array.from({ length: ASK_MAX_QUESTIONS }, (_, i) => question(i)) };
    expect(parseAskRequest(req)?.questions).toHaveLength(ASK_MAX_QUESTIONS);
  });

  // Distinct questions, so this can only fail on the count — the old version passed five
  // copies of one question, which the uniqueness refinement rejected on its own.
  it('rejects more than ASK_MAX_QUESTIONS questions', () => {
    const questions = Array.from({ length: ASK_MAX_QUESTIONS + 1 }, (_, i) => question(i));
    expect(parseAskRequest({ questions })).toBeNull();
  });

  it('rejects a question with fewer than 2 options', () => {
    expect(
      parseAskRequest({
        questions: [{ header: 'H', question: 'Q?', options: [{ label: 'only' }] }],
      }),
    ).toBeNull();
  });

  it('accepts a question with more than 4 options, up to ASK_MAX_OPTIONS', () => {
    const options = Array.from({ length: ASK_MAX_OPTIONS }, (_, i) => ({ label: `opt${i}` }));
    const req = { questions: [{ header: 'H', question: 'Q?', options }] };
    expect(parseAskRequest(req)?.questions[0]?.options).toHaveLength(ASK_MAX_OPTIONS);
  });

  it('rejects a question with more than ASK_MAX_OPTIONS options', () => {
    const options = Array.from({ length: ASK_MAX_OPTIONS + 1 }, (_, i) => ({ label: `opt${i}` }));
    expect(parseAskRequest({ questions: [{ header: 'H', question: 'Q?', options }] })).toBeNull();
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
          options: Array.from({ length: ASK_MAX_OPTIONS + 1 }, (_, i) => ({ label: `opt${i}` })),
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

describe('marker anchoring (last occurrence, trailing control lines)', () => {
  it('anchors on the LAST keyword occurrence so earlier prose cannot hijack the marker', () => {
    const text = `As CEZ:ASK requires, I stop here.\n\nCEZ:ASK ${askJson}`;
    expect(parseAskMarkerResult(text).kind).toBe('valid');
    expect(stripAskMarker(text)).toBe('As CEZ:ASK requires, I stop here.');
  });

  it('tolerates a trailing CEZ:DONE line after the payload', () => {
    expect(parseAskMarkerResult(`Pick one.\nCEZ:ASK ${askJson}\nCEZ:DONE`).kind).toBe('valid');
  });

  it('peels several trailing control lines, blank lines and indentation included', () => {
    const text = `Pick one.\nCEZ:ASK ${askJson}\n\n  CEZ:MONITORING  \n\nCEZ:DONE\n`;
    expect(parseAskMarkerResult(text).kind).toBe('valid');
  });

  it('keeps a control word that shares a line with other text', () => {
    expect(parseAskMarkerResult(`CEZ:ASK ${askJson} CEZ:DONE`).kind).toBe('invalid-json');
  });

  // CodeQL js/redos (#10): the old anchored regex backtracked cubically over trailing newlines —
  // 4,000 of them took ~13 s, 8,000 took 85 s, all of it on the server's event loop.
  it('trims a turn ending in thousands of blank lines in linear time', () => {
    const text = `CEZ:ASK {${'\n'.repeat(4000)}x`;
    const started = performance.now();
    expect(parseAskMarkerResult(text).kind).toBe('invalid-json');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('still diagnoses prose that trails the keyword as invalid-json', () => {
    expect(parseAskMarkerResult('I might use CEZ:ASK later on.').kind).toBe('invalid-json');
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

describe('card id, about and CEZ:ASK-CLOSE (Questions inbox spec)', () => {
  const q = { header: 'Merge', question: 'Merge it?', options: [{ label: 'Yes' }, { label: 'No' }] };

  it('keeps a valid card id and about', () => {
    const ask = parseAskMarker(`CEZ:ASK ${JSON.stringify({ id: 'merge-2891', about: [{ pr: 2891 }, { task: 'cezar/abc', ask: 'base' }], questions: [q] })}`);
    expect(ask?.id).toBe('merge-2891');
    expect(ask?.about).toEqual([{ pr: 2891 }, { task: 'cezar/abc', ask: 'base' }]);
  });

  it('drops an invalid id or about rather than the card', () => {
    const ask = parseAskMarker(`CEZ:ASK ${JSON.stringify({ id: 'has spaces', about: [{ pr: 'x' }], questions: [q] })}`);
    expect(ask?.questions).toHaveLength(1);
    expect(ask?.id).toBeUndefined();
    expect(ask?.about).toBeUndefined();
  });

  it('parses close markers on their own lines, with an optional reason', () => {
    const text = 'Done.\nCEZ:ASK-CLOSE design-v2 superseded by v3\n  CEZ:ASK-CLOSE Release\nnot a marker: CEZ:ASK-CLOSE x';
    expect(parseAskCloseMarkers(text)).toEqual([{ id: 'design-v2', reason: 'superseded by v3' }, { id: 'Release' }]);
    expect(stripAskCloseMarkers(text)).toBe('Done.\n\nnot a marker: CEZ:ASK-CLOSE x');
  });

  it('a close marker is not an ask marker', () => {
    expect(parseAskMarker('CEZ:ASK-CLOSE design-v2')).toBeNull();
  });

  it('a card followed by a close line still parses, and the close still applies', () => {
    const text = `New card.\nCEZ:ASK ${JSON.stringify({ id: 'design-v3', questions: [q] })}\nCEZ:ASK-CLOSE design-v2 superseded\nCEZ:DONE`;
    expect(parseAskMarkerResult(text).kind).toBe('valid');
    expect(parseAskMarker(text)?.id).toBe('design-v3');
    expect(parseAskCloseMarkers(text)).toEqual([{ id: 'design-v2', reason: 'superseded' }]);
  });
});

describe('reference markers in card text', () => {
  const pr = (n: number) => `[[pr:a-rather-long-project-slug/${n}]]`;
  const ask = (q: string, label: string, description?: string): unknown => ({
    questions: [{
      header: 'Dependabot',
      question: q,
      options: [{ label, ...(description === undefined ? {} : { description }) }, { label: 'Skip' }],
    }],
  });

  it('reads a marker as the chip it becomes', () => {
    expect(askVisibleText(`Start ${pr(2897)} and [[issue:p/12]] in [[task:p/abcdef12-3456]]?`))
      .toBe('Start #2897 and #12 in task abcdef12?');
    expect(askVisibleText('[[issue:p/abc]] and [[pr:p/x1]]')).toBe('issue abc and PR x1');
  });

  it('accepts markers in the question, a label and a description', () => {
    const request = ask(`Assess ${pr(2897)} and ${pr(2896)}?`, `Assess ${pr(2897)}`, `Opens a task for ${pr(2897)}`);
    expect(parseAskRequest(request)).toEqual(request);
  });

  it('measures the limits on the visible text, not the raw markers', () => {
    // 4 visible-char marker (#123) + 56 = 60: the raw label is far over 60 but reads as 60.
    const label = `${pr(123)}${'x'.repeat(56)}`;
    expect(label.length).toBeGreaterThan(60);
    expect(parseAskRequest(ask('Which?', label))).not.toBeNull();
    expect(parseAskRequest(ask('Which?', `${label}y`))).toBeNull();
    const question = `${'q'.repeat(395)}${pr(1234)}`;
    expect(parseAskRequest(ask(question, 'Go'))).not.toBeNull();
    expect(parseAskRequest(ask(`${question}?`, 'Go'))).toBeNull();
  });

  it('still bounds the raw payload', () => {
    expect(parseAskRequest(ask('Which?', `[[pr:${'p'.repeat(300)}/1]]`))).toBeNull();
  });

  it('clips an over-long description without cutting a marker in half', () => {
    const description = `${'d'.repeat(275)}${pr(28970)} and more`;
    const result = parseAskMarkerResult(`CEZ:ASK ${JSON.stringify(ask('Which?', 'Go', description))}`);
    expect(result).toMatchObject({ kind: 'valid', normalized: true });
    const clipped = result.kind === 'valid' ? result.request.questions[0]!.options[0]!.description : undefined;
    expect(clipped).toBe('d'.repeat(275));
  });

  it('keeps a marker that fits whole when clipping', () => {
    const description = `${'d'.repeat(270)}${pr(2897)}${'e'.repeat(20)}`;
    const result = parseAskMarkerResult(`CEZ:ASK ${JSON.stringify(ask('Which?', 'Go', description))}`);
    const clipped = result.kind === 'valid' ? result.request.questions[0]!.options[0]!.description : undefined;
    expect(clipped).toBe(`${'d'.repeat(270)}${pr(2897)}${'e'.repeat(5)}`);
    expect(askVisibleText(clipped!)).toHaveLength(280);
  });
});
