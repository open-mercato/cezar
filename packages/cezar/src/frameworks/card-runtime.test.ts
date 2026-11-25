import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunCard } from '@open-mercato/cezar-contract';
import { buildChildEnv } from '../core/agent-env.ts';
import { terminalEnv } from '../server/terminal/sessions.ts';
import { globMatches, missingArtifacts } from './artifacts.ts';
import { endsWithStageDoneMarker, runPrecheck, stripStageDoneMarker, tagCardStage, takeNextQueued } from './card-runtime.ts';
import { SDD_APPROVAL_ENV } from './state.ts';

const card = (order: number, held = false): RunCard => ({
  framework: 'generic', frameworkHash: 'h', title: 't', stage: 'plan', stages: {}, stageOrder: ['plan'], order, ...(held ? { held } : {}),
});

describe('takeNextQueued (engine step 7)', () => {
  const pick = (queue: string[], cards: Record<string, RunCard>, startable: (id: string) => boolean = (id) => !cards[id]?.held) => {
    const q = [...queue];
    const taken = takeNextQueued(q, startable, (id) => cards[id]);
    return { taken, rest: q };
  };

  it('guard: with no cards it is exactly findIndex(startable)', () => {
    const queue = ['a', 'b', 'c'];
    for (const blocked of [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      const startable = (id: string) => !blocked.includes(id);
      const expected = queue.findIndex(startable);
      const { taken, rest } = pick(queue, {}, startable);
      expect(taken).toBe(expected === -1 ? undefined : queue[expected]);
      expect(rest).toEqual(expected === -1 ? queue : queue.filter((_, i) => i !== expected));
    }
  });

  it('a held card never starts', () => {
    expect(pick(['h'], { h: card(1, true) }).taken).toBeUndefined();
    expect(pick(['h', 'x'], { h: card(1, true) }).taken).toBe('x');
  });

  it('queued cards go in Ready order, in the slot of the earliest-queued card', () => {
    const cards = { c1: card(5), c2: card(1), c3: card(3) };
    const first = pick(['c1', 'adhoc', 'c2', 'c3'], cards);
    expect(first.taken).toBe('c2');
    // c1 moved into c2's slot: the ad-hoc run is now ahead of every remaining card but one.
    expect(first.rest).toEqual(['adhoc', 'c1', 'c3']);
  });

  it('an ad-hoc run queued before every card starts first; one queued after waits for the earlier cards', () => {
    expect(pick(['adhoc', 'c1'], { c1: card(1) }).taken).toBe('adhoc');
    const cards = { c1: card(2), c2: card(1) };
    let queue = ['c1', 'c2', 'late'];
    const order: string[] = [];
    while (queue.length) {
      const { taken, rest } = pick(queue, cards);
      order.push(taken!);
      queue = rest;
    }
    expect(order).toEqual(['c2', 'c1', 'late']);
  });

  it('an ad-hoc run is not starved by cards reordered ahead of it', () => {
    const cards = { c1: card(3), c2: card(2), c3: card(1) };
    let queue = ['c1', 'adhoc', 'c2', 'c3'];
    const order: string[] = [];
    while (queue.length) {
      const { taken, rest } = pick(queue, cards);
      order.push(taken!);
      queue = rest;
    }
    expect(order.indexOf('adhoc')).toBe(1);
  });
});

describe('tagCardStage (D4)', () => {
  const base: RunCard = { ...card(1), stage: 'a', stageOrder: ['a', 'b', 'c'], stages: { a: 'running', b: 'pending', c: 'skipped' } };
  it('forward marks the stage left done; back reopens; history records the move', () => {
    const forward = tagCardStage(base, 'b');
    expect(forward.stages).toEqual({ a: 'done', b: 'running', c: 'skipped' });
    expect(forward.history?.at(-1)?.text).toBe('moved to b');
    const back = tagCardStage(forward, 'a');
    expect(back.stages).toEqual({ a: 'running', b: 'pending', c: 'skipped' });
    expect(back.history?.at(-1)?.text).toBe('back to a');
    expect(tagCardStage(base, 'a')).toEqual(base);
  });
});

describe('artifacts (D14)', () => {
  let root: string | undefined;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));
  it('names the globs that match nothing, and never leaves the worktree', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-art-'));
    mkdirSync(join(root, '.ai/specs/2026-11-23-tax'), { recursive: true });
    writeFileSync(join(root, '.ai/specs/2026-11-23-tax/brief.md'), 'x');
    expect(await missingArtifacts(root, ['.ai/specs/*-tax/brief.md', '.ai/specs/*-tax/spec.md', '**/brief.md', '../x', '/etc/hosts'])).toEqual([
      '.ai/specs/*-tax/spec.md', '../x', '/etc/hosts',
    ]);
    expect(globMatches('.ai/specs/*/change.json', '.ai/specs/2026-11-23-tax/change.json')).toBe(true);
    expect(globMatches('.ai/specs/*/change.json', '.ai/specs/a/b/change.json')).toBe(false);
  });
});

describe('STAGE-DONE marker', () => {
  it('reads only a trailing marker', () => {
    expect(endsWithStageDoneMarker('ok\n\nCEZ:STAGE-DONE\n')).toBe(true);
    expect(endsWithStageDoneMarker('CEZ:STAGE-DONE then more')).toBe(false);
    expect(endsWithStageDoneMarker('CEZ:DONE')).toBe(false);
  });
  it('reads and strips a marker followed by punctuation or emphasis', () => {
    expect(endsWithStageDoneMarker('ok\n\nCEZ:STAGE-DONE.\n')).toBe(true);
    expect(endsWithStageDoneMarker('ok **CEZ:STAGE-DONE**  ')).toBe(true);
    expect(stripStageDoneMarker('All set.\n\nCEZ:STAGE-DONE.\n')).toBe('All set.');
    expect(stripStageDoneMarker('All set. **CEZ:STAGE-DONE**')).toBe('All set.');
    expect(stripStageDoneMarker('CEZ:STAGE-DONE then more')).toBe('CEZ:STAGE-DONE then more');
  });
});

describe(`${SDD_APPROVAL_ENV} never leaves cezar's own approve spawn (D9)`, () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is absent from every agent environment, full inheritance and passthrough included', () => {
    const source = { PATH: '/bin', [SDD_APPROVAL_ENV]: '2026-11-23-x' };
    expect(buildChildEnv({ backend: 'claude', source })[SDD_APPROVAL_ENV]).toBeUndefined();
    expect(buildChildEnv({ backend: 'codex', source: { ...source, CEZ_AGENT_ENV_FULL: '1' } })[SDD_APPROVAL_ENV]).toBeUndefined();
    expect(buildChildEnv({ backend: 'claude', source: { ...source, CEZ_ENV_PASSTHROUGH: SDD_APPROVAL_ENV } })[SDD_APPROVAL_ENV]).toBeUndefined();
  });

  it('is absent from a terminal cezar opens', () => {
    vi.stubEnv(SDD_APPROVAL_ENV, '2026-11-23-x');
    expect(terminalEnv()[SDD_APPROVAL_ENV]).toBeUndefined();
    expect(terminalEnv().TERM).toBe('xterm-256color');
  });

  it('is absent from a terminal in any spelling', () => {
    vi.stubEnv('sdd_noninteractive_approval', '2026-11-23-x');
    expect(Object.keys(terminalEnv()).some((k) => k.toUpperCase() === SDD_APPROVAL_ENV)).toBe(false);
  });

  it('is absent from a stage precheck', async () => {
    vi.stubEnv(SDD_APPROVAL_ENV, '2026-11-23-x');
    const result = await runPrecheck(`node -e "process.stdout.write(process.env.${SDD_APPROVAL_ENV} ?? 'absent')"`, tmpdir());
    expect(result).toEqual({ ok: true, output: 'absent' });
  });
});
