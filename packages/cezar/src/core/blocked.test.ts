import { describe, expect, it } from 'vitest';
import { nearIdenticalReplies, parseBlockedMarker, replyKey, stripBlockedMarker } from './blocked.ts';

describe('CEZ:BLOCKED marker (#1540)', () => {
  const ok = 'Need a token.\nCEZ:BLOCKED {"category":"credential","resume":"token is exported"}';
  it('parses a valid trailing line', () => {
    expect(parseBlockedMarker(ok)).toEqual({ category: 'credential', resume: 'token is exported' });
  });
  it('never reads prose, bad categories, missing resume or non-trailing lines as a blocker', () => {
    expect(parseBlockedMarker('I am blocked: I cannot log in, so I have to stop.')).toBeNull();
    expect(parseBlockedMarker('CEZ:BLOCKED {"category":"nonsense","resume":"x"}')).toBeNull();
    expect(parseBlockedMarker('CEZ:BLOCKED {"category":"other"}')).toBeNull();
    expect(parseBlockedMarker('CEZ:BLOCKED {not json}')).toBeNull();
    expect(parseBlockedMarker(`${ok}\nand then more prose`)).toBeNull();
  });
  it('strips the marker line from visible text', () => {
    expect(stripBlockedMarker(ok)).toBe('Need a token.');
  });
  it('treats replies as near-identical across counters and spacing, not across different work', () => {
    const a = replyKey('Blocked: no token.  Attempt 3 failed.');
    expect(nearIdenticalReplies(a, replyKey('blocked: no token. attempt 4 failed.'))).toBe(true);
    expect(nearIdenticalReplies(a, replyKey('I refactored the parser and added three tests for the lexer'))).toBe(false);
  });
});
