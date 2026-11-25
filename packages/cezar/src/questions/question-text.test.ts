import { describe, expect, it } from 'vitest';
import { questionSummary, splitQuestionText } from '@open-mercato/cezar-contract';

describe('splitQuestionText (#2477)', () => {
  it('returns a text with no --- line whole, line breaks included', () => {
    expect(splitQuestionText('Approve the plan?\nTwo tables change.')).toEqual({ main: 'Approve the plan?\nTwo tables change.' });
  });

  it('splits at the first line that is exactly ---', () => {
    expect(splitQuestionText('Approve?\n\n---\nStep 1\n---\nStep 2\n')).toEqual({ main: 'Approve?', details: 'Step 1\n---\nStep 2' });
  });

  it('accepts CRLF line endings and trailing blanks on the marker', () => {
    expect(splitQuestionText('Approve?\r\n--- \r\nStep 1\r\n')).toEqual({ main: 'Approve?', details: 'Step 1' });
  });

  it('never splits on --- inside a line, an indented ---, or a longer rule', () => {
    for (const text of ['a --- b', 'Approve?\n  ---\nmore', 'Approve?\n----\nmore', 'Approve?\n---x\nmore', 'Approve?\n***\nmore']) {
      expect(splitQuestionText(text)).toEqual({ main: text });
    }
  });

  it('drops an empty Details section, and the rule with it', () => {
    expect(splitQuestionText('only a question\n---\n  \n')).toEqual({ main: 'only a question' });
  });

  it('keeps the text whole when nothing is above the marker', () => {
    expect(splitQuestionText('---\nonly details')).toEqual({ main: '---\nonly details' });
    expect(splitQuestionText('\n  \n---\nonly details')).toEqual({ main: '\n  \n---\nonly details' });
  });
});

describe('questionSummary (#2477)', () => {
  it('keeps only the part above ---, its line breaks flattened', () => {
    expect(questionSummary('Approve the plan?\nTwo tables change.\r\n\nNothing is dropped.\n---\nStep 1\nStep 2')).toBe(
      'Approve the plan? Two tables change. Nothing is dropped.',
    );
  });

  it('leaves a one-line question as it is', () => {
    expect(questionSummary('Which date library?')).toBe('Which date library?');
  });
});
