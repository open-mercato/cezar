import { describe, expect, it } from 'vitest';
import { classifyGateReply, gateCardText } from './gate-reply.ts';

describe('gateCardText (#2477)', () => {
  const note = 'Reply with instructions in text, or choose an option.';

  it('is the message alone without a note', () => {
    expect(gateCardText('Approve?\n---\nContext', undefined)).toBe('Approve?\n---\nContext');
  });

  it('appends the note after a blank line, as before, when the message has no --- line', () => {
    expect(gateCardText('Approve the plan?', note)).toBe(`Approve the plan?\n\n${note}`);
  });

  it('puts the note above the --- line, so it never folds under Details', () => {
    expect(gateCardText('Approve?\n\n---\nStep 1\n---\nStep 2', note)).toBe(`Approve?\n\n${note}\n---\nStep 1\n---\nStep 2`);
  });

  it('drops a --- line with nothing after it, so no empty Details is left behind the note', () => {
    expect(gateCardText('Approve?\n---\n  \n', note)).toBe(`Approve?\n\n${note}`);
  });

  it('appends the note when the message starts with ---, which the card shows whole', () => {
    expect(gateCardText('---\nContext', note)).toBe(`---\nContext\n\n${note}`);
  });
});

describe('workflow gate replies', () => {
  it.each(['Reject', 'Request changes', 'Do not open a PR', 'No, stop here'])('uses the reject path for %s', (reply) => {
    expect(classifyGateReply(reply, true)).toEqual({ decision: 'reject' });
  });

  it.each(['Stop here.', 'Not yet', 'Wait', 'Hold off for now', 'Never mind', 'No thanks', 'n', 'Nah', 'Skip the PR', 'Cancel this', "Don't push"])(
    'never approves a stop or hold reply: %s', (reply) => {
      expect(classifyGateReply(reply, true)).toEqual({ decision: 'reject' });
    },
  );

  it.each(['Skip the flaky test, then open the PR', "Don't push the env file, rebase first", 'Wait for CI, then open the PR'])(
    'keeps %s as instructions', (instructions) => {
      expect(classifyGateReply(instructions, false)).toEqual({ decision: 'approve', instructions });
    },
  );

  it('accepts the full PR option and applies instructions alongside a full PR request', () => {
    expect(classifyGateReply('Open full PR', true)).toEqual({ decision: 'approve', fullPr: true });
    const instructions = 'Rebase first, open a full PR, not a draft.';
    expect(classifyGateReply(instructions, true)).toEqual({ decision: 'approve', instructions, fullPr: true });
  });

  it.each(['Do not open a full PR. Open a draft PR.', 'Reject the first finding, then open the PR.'])(
    'keeps %s as instructions for a draft PR', (instructions) => {
      expect(classifyGateReply(instructions, true)).toEqual({ decision: 'approve', instructions });
    },
  );

  it('keeps a gate waiting when the reply has no text', () => {
    expect(classifyGateReply('  ', true)).toBeUndefined();
  });
});
