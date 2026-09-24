import { describe, expect, it } from 'vitest';
import { parseTaskMarkers, stripTaskMarkers } from './task-markers.ts';

/** Spec 2026-07-18-task-ref-markers — the in-band declaration layer above the fuzzy tiers. */
describe('parseTaskMarkers', () => {
  it('reads each marker off its own line', () => {
    expect(parseTaskMarkers('Working on it.\nCEZ:PR=442\nCEZ:ISSUE=433\nCEZ:TITLE=fixing plan rendering\ndone soon')).toEqual({
      pr: 442,
      issue: 433,
      title: 'fixing plan rendering',
    });
  });

  it('the last occurrence of a marker wins', () => {
    expect(parseTaskMarkers('CEZ:PR=1\nsome progress\nCEZ:PR=500')).toEqual({ pr: 500 });
    expect(parseTaskMarkers('CEZ:TITLE=first guess\nCEZ:TITLE=implementing comment threads')).toEqual({
      title: 'implementing comment threads',
    });
  });

  it('is line-anchored — prose mentions and inline text never parse', () => {
    expect(parseTaskMarkers('I will emit CEZ:PR=442 when the PR exists')).toEqual({});
    expect(parseTaskMarkers('  CEZ:PR=442')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=442 (the review PR)')).toEqual({});
  });

  it('the instruction placeholder and junk values are inert', () => {
    expect(parseTaskMarkers('CEZ:PR=<number>')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=0')).toEqual({});
    expect(parseTaskMarkers('CEZ:PR=99999999999')).toEqual({});
    expect(parseTaskMarkers('CEZ:TITLE=   ')).toEqual({});
  });

  it('tolerates trailing whitespace and CRLF line endings', () => {
    expect(parseTaskMarkers('CEZ:PR=7  \r\nCEZ:ISSUE=9\r\n')).toEqual({ pr: 7, issue: 9 });
  });

  it('finds nothing in plain prose', () => {
    expect(parseTaskMarkers('renamed the settings page')).toEqual({});
    expect(parseTaskMarkers('')).toEqual({});
  });
});

/** Spec 2026-07-21-report-ref-discovery — the report-tier lines skills end their runs with. */
describe('parseTaskMarkers — report-tier reference lines', () => {
  it('reads the human-friendly PR/Issue report lines', () => {
    const report = [
      'om-auto-create-pr: add dark mode',
      'Issue: #433 (link: https://github.com/open-mercato/cezar/issues/433)',
      'PR: #442 (link: https://github.com/open-mercato/cezar/pull/442)',
      'Status: complete',
    ].join('\n');
    expect(parseTaskMarkers(report)).toEqual({ pr: 442, issue: 433 });
  });

  it('a CEZ declaration in the same turn outranks a report line', () => {
    expect(
      parseTaskMarkers('CEZ:PR=7\nPR: #442 (link: https://github.com/o/r/pull/442)'),
    ).toEqual({ pr: 7 });
    expect(
      parseTaskMarkers('Issue: #9 (link: https://github.com/o/r/issues/9)\nCEZ:ISSUE=3'),
    ).toEqual({ issue: 3 });
  });

  it('still accepts the legacy env-style markers from older skill versions', () => {
    expect(parseTaskMarkers('PR_URL=https://github.com/o/r/pull/442\nPR_NUMBER=442')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('PR_URL=https://github.com/o/r/pull/442')).toEqual({ pr: 442 });
    expect(parseTaskMarkers('ISSUE_NUMBER=12')).toEqual({ issue: 12 });
  });

  it('a report line outranks a legacy marker; the last report line wins', () => {
    expect(parseTaskMarkers('PR_NUMBER=1\nPR: #2 (link: https://github.com/o/r/pull/2)')).toEqual({ pr: 2 });
    expect(
      parseTaskMarkers(
        'PR: #1 (link: https://github.com/o/r/pull/1)\nPR: #2 (link: https://github.com/o/r/pull/2)',
      ),
    ).toEqual({ pr: 2 });
  });

  it('is line-anchored and exact-shape — prose, placeholders and decorated lines never parse', () => {
    expect(parseTaskMarkers('the report ends with PR: #442 (link: https://github.com/o/r/pull/442)')).toEqual({});
    expect(parseTaskMarkers('PR: #<PR number> (link: <full PR URL>)')).toEqual({});
    expect(parseTaskMarkers('- PR: #442 (link: https://github.com/o/r/pull/442)')).toEqual({});
    expect(parseTaskMarkers('PR: #442 (link: https://github.com/o/r/pull/442) — merged')).toEqual({});
    expect(parseTaskMarkers('PR: 442')).toEqual({});
  });

  it('tolerates trailing whitespace and CRLF', () => {
    expect(parseTaskMarkers('PR: #7 (link: https://github.com/o/r/pull/7)  \r\n')).toEqual({ pr: 7 });
  });
});

describe('stripTaskMarkers', () => {
  it('removes complete marker lines and keeps the surrounding text', () => {
    expect(stripTaskMarkers('Opened the PR.\nCEZ:PR=442\nCEZ:TITLE=fixing plan rendering\nNext: tests.')).toBe(
      'Opened the PR.\nNext: tests.',
    );
  });

  it('leaves prose mentions and non-marker lines alone', () => {
    const text = 'I will emit CEZ:PR=442 later\nnormal line';
    expect(stripTaskMarkers(text)).toBe(text);
  });

  it('is a no-op on text without any CEZ prefix', () => {
    expect(stripTaskMarkers('plain progress update')).toBe('plain progress update');
  });

  it('leaves report-tier reference lines visible — they are human-readable by design', () => {
    const text = 'PR: #442 (link: https://github.com/o/r/pull/442)\nCEZ:PR=442\ndone';
    expect(stripTaskMarkers(text)).toBe('PR: #442 (link: https://github.com/o/r/pull/442)\ndone');
  });
});
