import { describe, expect, it } from 'vitest';
import { buildCommitMessagePrompt, cleanSubject } from './commit-message.ts';

describe('commit message (spec 2026-10-20-trunk-based-projects)', () => {
  it('keeps one clean subject line from the model answer', () => {
    expect(cleanSubject('"Summarize the Q3 planning meeting."\n\nmore text')).toBe('Summarize the Q3 planning meeting');
    expect(cleanSubject('```\nAdd action items\n```')).toBe('Add action items');
    expect(cleanSubject('   ')).toBeUndefined();
    expect(cleanSubject('{"title":"x"}')).toBeUndefined();
    expect(cleanSubject('x'.repeat(100))?.length).toBe(72);
  });

  it('puts the files and the diff in the prompt, with the request only as context', () => {
    const prompt = buildCommitMessagePrompt({ files: [{ status: 'A', path: 'summary.md' }], patch: '+hello' }, 'add a summary');
    expect(prompt).toContain('A\tsummary.md');
    expect(prompt).toContain('+hello');
    expect(prompt).toContain('context only');
  });
});
