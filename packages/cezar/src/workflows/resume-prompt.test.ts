import { describe, expect, it } from 'vitest';

import type { RunEvent } from '../runs/store.ts';
import { laterInstructions, resumeWithContext } from './resume-prompt.ts';

const message = (text: string, seq = 1): RunEvent => ({ seq, ts: '', type: 'user-message', text });

describe('resume prompt', () => {
  it('states the task plainly when nothing came after it', () => {
    expect(resumeWithContext('Continue.', 'Fix the bug', [], [])).toBe('Continue.\n\nThe task:\n\nFix the bug');
  });

  it('labels the original as superseded and puts newer instructions after it', () => {
    const prompt = resumeWithContext('Continue.', 'Research only', ['Now implement it'], ['And open a PR']);
    expect(prompt.indexOf('Research only')).toBeLessThan(prompt.indexOf('Now implement it'));
    expect(prompt.indexOf('Now implement it')).toBeLessThan(prompt.indexOf('And open a PR'));
    expect(prompt).toContain('replace it wherever they differ');
    expect(prompt).toContain('these are the newest instructions');
  });

  it('keeps the user\'s newest messages and drops cezar\'s own openings and the task itself', () => {
    const events: RunEvent[] = [
      message('the task'),
      { seq: 2, ts: '', type: 'text', text: 'agent output' },
      message('one'),
      message('AUTO: resumed'),
      message('two'),
      message('three'),
      message('four'),
      message('   '),
    ];
    expect(laterInstructions(events, 'the task', ['AUTO:'])).toEqual(['two', 'three', 'four']);
  });
});
