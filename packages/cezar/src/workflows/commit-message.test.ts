import { describe, expect, it } from 'vitest';
import { buildCommitMessagePrompt, cleanSubject } from './commit-message.ts';

describe('commit message (spec 2026-10-20-trunk-based-projects)', () => {
  it('takes the subject from the JSON answer', () => {
    expect(cleanSubject('{"subject": "Summarize the Q3 planning meeting."}')).toBe('Summarize the Q3 planning meeting');
    expect(cleanSubject('```json\n{"subject":"ingest: Open Mercato call, 6 tasks"}\n```')).toBe('ingest: Open Mercato call, 6 tasks');
  });

  it('refuses a remark, a question, prose or a subject that would need cutting', () => {
    // The live answer that shipped as a commit subject.
    expect(cleanSubject('{"subject": "The names in vault/projects/shopware/Shopware Framework Team.md are already correct"}')).toBeUndefined();
    expect(cleanSubject('{"subject": "Should I also update the daily note?"}')).toBeUndefined();
    expect(cleanSubject('Add action items')).toBeUndefined();
    expect(cleanSubject(JSON.stringify({ subject: `Add ${'x'.repeat(80)}` }))).toBeUndefined();
    expect(cleanSubject('{"subject": "   "}')).toBeUndefined();
  });

  it('puts recent subjects, the files and the diff in the prompt, with the request only as context', () => {
    const prompt = buildCommitMessagePrompt(
      { files: [{ status: 'A', path: 'summary.md' }], patch: '+hello' },
      'add a summary',
      ['ingest: call with Ana, 2 tasks'],
    );
    expect(prompt).toContain('ingest: call with Ana, 2 tasks');
    expect(prompt).toContain('A\tsummary.md');
    expect(prompt).toContain('+hello');
    expect(prompt).toContain('context only');
  });

  it('reports why it produced nothing, so a fallback is explainable', async () => {
    const { generateCommitMessage } = await import('./commit-message.ts');
    const previous = process.env.CEZ_AUTONAME;
    process.env.CEZ_AUTONAME = '0';
    try {
      expect(await generateCommitMessage('/nowhere', { files: [{ status: 'A', path: 'a.md' }], patch: '' })).toEqual({ reason: 'model naming is off' });
    } finally {
      if (previous === undefined) delete process.env.CEZ_AUTONAME;
      else process.env.CEZ_AUTONAME = previous;
    }
  });
});
