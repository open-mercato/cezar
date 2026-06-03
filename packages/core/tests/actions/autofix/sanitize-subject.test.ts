import { describe, it, expect } from 'vitest';
import { buildCommitMessage } from '../../../src/actions/autofix/messages.js';
import { normalizeTitle } from '../../../src/actions/autofix/prompts/untrusted.js';
import type { FixReport } from '../../../src/actions/autofix/prompts/fixer.js';

describe('normalizeTitle', () => {
  it('collapses whitespace runs (including newlines) into single spaces', () => {
    expect(normalizeTitle('a\nb\t c   d')).toBe('a b c d');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTitle('  hello world  ')).toBe('hello world');
  });

  it('strips leading hash characters', () => {
    expect(normalizeTitle('### heading style title')).toBe('heading style title');
  });

  it('caps length at 72 chars', () => {
    const long = 'x'.repeat(200);
    expect(normalizeTitle(long)).toHaveLength(72);
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeTitle('   \n\t  ')).toBe('');
  });
});

describe('buildCommitMessage', () => {
  const report: FixReport = {
    approach: 'Did the thing.',
    changedFiles: [],
    testCommandsRun: [],
  } as unknown as FixReport;

  it('keeps the commit subject on a single line for a multi-line title', () => {
    const msg = buildCommitMessage(42, 'broken\nthing here', report);
    const subject = msg.split('\n', 1)[0];
    expect(subject).toBe('fix: broken thing here (#42)');
  });
});
