import { describe, expect, it } from 'vitest';
import { classifyGateReply } from './gate-reply.ts';

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
