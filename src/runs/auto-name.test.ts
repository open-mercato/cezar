import { afterEach, describe, expect, it } from 'vitest';
import {
  autoNamingActive,
  buildNamerPrompt,
  composeNameResult,
  crossCheckRefs,
  liveTitleUpdatesEnabled,
  postValidateTitle,
  TITLE_MAX,
} from './auto-name.js';

/** The namer's pure half (spec 2026-07-17-task-auto-naming): prompt, cross-check, post-validation. */

describe('buildNamerPrompt', () => {
  it('carries the marker, skill identity, clipped task, and advisory refs', () => {
    const prompt = buildNamerPrompt({
      task: 'review pr 437 with autofix',
      skillName: 'om-auto-review-pr',
      skillDescription: 'Review a PR by number.',
    });
    expect(prompt.startsWith('[cez-namer]')).toBe(true);
    expect(prompt).toContain('Selected skill: /om-auto-review-pr');
    expect(prompt).toContain('review pr 437 with autofix');
    expect(prompt).toContain('pr 437');
  });

  it('includes turn context and diff stat only when given (live refresh)', () => {
    const base = buildNamerPrompt({ task: 't' });
    expect(base).not.toContain('Latest progress');
    const live = buildNamerPrompt({ task: 't', turnText: 'implemented the parser', diffStat: '3 files, +40 -2' });
    expect(live).toContain('implemented the parser');
    expect(live).toContain('3 files, +40 -2');
  });
});

describe('crossCheckRefs', () => {
  it('accepts a model number confirmed by the regex layer', () => {
    expect(crossCheckRefs({ pr: 437 }, 'review pr 437', { prNumber: 437 })).toEqual({ prNumber: 437 });
  });

  it('accepts a model classification of an ambiguous number', () => {
    expect(crossCheckRefs({ pr: 469 }, '469', { ambiguousNumber: 469 })).toEqual({ prNumber: 469 });
    expect(crossCheckRefs({ issue: 469 }, '469', { ambiguousNumber: 469 })).toEqual({ issueNumber: 469 });
  });

  it('rejects hallucinated numbers not present in the task', () => {
    expect(crossCheckRefs({ pr: 999 }, 'rename the settings page', {})).toEqual({});
  });

  it('the regex wins every disagreement', () => {
    expect(crossCheckRefs({ pr: 999 }, 'review pr 437', { prNumber: 437 })).toEqual({ prNumber: 437 });
  });

  it('accepts a number that occurs in the task even without a regex kind', () => {
    expect(crossCheckRefs({ issue: 12 }, 'the regression from 12 broke prod', {})).toEqual({ issueNumber: 12 });
    // Substring matches do not count — 12 inside 512 is not a reference.
    expect(crossCheckRefs({ issue: 12 }, 'bump to node 512', {})).toEqual({});
  });
});

describe('postValidateTitle', () => {
  it('leads with the number, lowercases, strips trailing periods and model-repeated numbers', () => {
    expect(postValidateTitle('Implementing CR fixes.', 437)).toBe('437: implementing CR fixes');
    expect(postValidateTitle('437: implementing cr fixes', 437)).toBe('437: implementing cr fixes');
    expect(postValidateTitle('#437 — implementing cr fixes', 437)).toBe('437: implementing cr fixes');
  });

  it('caps at TITLE_MAX code points with an ellipsis', () => {
    const long = 'x'.repeat(TITLE_MAX * 2);
    const out = postValidateTitle(long, undefined);
    expect([...out].length).toBeLessThanOrEqual(TITLE_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('works without a number', () => {
    expect(postValidateTitle('Renaming the settings page', undefined)).toBe('renaming the settings page');
  });
});

describe('composeNameResult', () => {
  const ctx = { task: '437', skillName: 'om-auto-review-pr' };

  it('parses a fenced JSON answer and applies the whole pipeline', () => {
    const raw = '```json\n{"title": "Implementing CR fixes", "pr": 437}\n```';
    expect(composeNameResult(raw, ctx)).toEqual({ titleSummary: '437: implementing CR fixes', prNumber: 437 });
  });

  it('survives prose around the JSON object', () => {
    const raw = 'Sure! Here is the name:\n{"title": "verifying pr ui", "pr": 437}\nHope that helps.';
    expect(composeNameResult(raw, ctx)).toEqual({ titleSummary: '437: verifying pr ui', prNumber: 437 });
  });

  it('returns null on junk (caller retries, then keeps the heuristic)', () => {
    expect(composeNameResult('I cannot help with that.', ctx)).toBeNull();
    expect(composeNameResult('{"nope": true}', ctx)).toBeNull();
  });

  it.each([
    'Loading the pipeline config and tracker descriptor, then claim PR #469.Config loaded',
    'Reading the handoff file for context.The task is UI QA verification of PR #476',
  ])('rejects concatenated progress narration: %s', (title) => {
    expect(composeNameResult(JSON.stringify({ title }), ctx)).toBeNull();
  });

  it('drops hallucinated refs but keeps the validated title', () => {
    const raw = '{"title": "renaming the settings page", "pr": 999}';
    expect(composeNameResult(raw, { task: 'rename the settings page' })).toEqual({
      titleSummary: 'renaming the settings page',
    });
  });
});

describe('generateRunName (dry run)', () => {
  it('answers a short, pr-classified title through the mock runner and never throws', async () => {
    const saved = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = mkdtempSync(join(tmpdir(), 'cez-namer-'));
      try {
        const { generateRunName } = await import('./auto-name.js');
        const result = await generateRunName(root, { task: '437', skillName: 'om-auto-review-pr' });
        expect(result).toEqual({ titleSummary: '437: implementing cr fixes', prNumber: 437 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (saved === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = saved;
    }
  }, 30_000);
});

describe('liveTitleUpdatesEnabled', () => {
  const saved = process.env.CEZ_TITLE_UPDATES;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_TITLE_UPDATES;
    else process.env.CEZ_TITLE_UPDATES = saved;
  });

  it('defaults ON (owner decision, PR #479)', () => {
    delete process.env.CEZ_TITLE_UPDATES;
    expect(liveTitleUpdatesEnabled({})).toBe(true);
  });

  it('the env default turns it off with exactly "0"', () => {
    expect(liveTitleUpdatesEnabled({}, { CEZ_TITLE_UPDATES: '0' })).toBe(false);
    expect(liveTitleUpdatesEnabled({}, { CEZ_TITLE_UPDATES: '1' })).toBe(true);
    expect(liveTitleUpdatesEnabled({}, { CEZ_TITLE_UPDATES: 'off' })).toBe(true);
  });

  it('the Settings toggle (config) wins over the env in both directions', () => {
    expect(liveTitleUpdatesEnabled({ liveTitleUpdates: false }, {})).toBe(false);
    expect(liveTitleUpdatesEnabled({ liveTitleUpdates: true }, { CEZ_TITLE_UPDATES: '0' })).toBe(true);
    expect(liveTitleUpdatesEnabled({ liveTitleUpdates: false }, { CEZ_TITLE_UPDATES: '1' })).toBe(false);
  });
});

describe('autoNamingActive', () => {
  it('on by default; CEZ_AUTONAME=0 kills it; dry-run is off unless forced', () => {
    expect(autoNamingActive({})).toBe(true);
    expect(autoNamingActive({ CEZ_AUTONAME: '0' })).toBe(false);
    expect(autoNamingActive({ CEZ_DRY_RUN: '1' })).toBe(false);
    expect(autoNamingActive({ CEZ_DRY_RUN: '1', CEZ_AUTONAME: '1' })).toBe(true);
    expect(autoNamingActive({ CEZ_DRY_RUN: '1', CEZ_AUTONAME: '0' })).toBe(false);
  });
});
