import { describe, expect, it } from 'vitest';
import { FORWARD_CLOSE, FORWARD_OPEN, placeholderIn, withForwarded } from './forward.ts';

describe('placeholderIn', () => {
  it.each([
    'File this: [transcript here]',
    'Notes:\n[paste the transcript below]',
    '[full text omitted]',
    '<<<TRANSCRIPT>>>',
    '{{ transcript }}',
    '<paste transcript>',
    '<transcript here>',
    'Summary (transcript omitted)',
    'TODO-insert the notes',
    'TODO: paste it',
    'PASTE HERE',
    'Content: PASTE',
    '[tu wklej transkrypcję]',
  ])('finds the marker in %j', (text) => {
    expect(placeholderIn(text)).toBeDefined();
  });

  it.each([
    'Fix the paste handler in the composer',
    'See [the docs](https://example.com) and [click here](https://x.y)',
    'File this transcript as meeting notes',
    'Compare a << b and c >> d',
    'Write the content below the header',
    'TODO list cleanup',
    '',
  ])('leaves %j alone', (text) => {
    expect(placeholderIn(text)).toBeUndefined();
  });
});

describe('withForwarded', () => {
  it('keeps the message byte for byte between its marker lines', () => {
    const text = 'Zażółć "gęślą" jaźń — it\'s $HOME `whoami` $(rm -rf /)\n\n  indented\ttab';
    const out = withForwarded('File it', text, 0);
    expect(out).toBe(`File it\n\n${FORWARD_OPEN}\n${text}\n${FORWARD_CLOSE}`);
  });

  it('works with no objective and says when files ride along', () => {
    expect(withForwarded(undefined, '', 2)).toBe(`${FORWARD_OPEN}\n(The user's 2 attachments are attached to this message.)\n${FORWARD_CLOSE}`);
  });
});
