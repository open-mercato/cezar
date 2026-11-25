import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardNotStarted, type RunCard } from '@open-mercato/cezar-contract';
import { RunStore } from './store.ts';

// Spec 2026-11-15-framework-board D1: a card is a run record with an optional `card` field.

const OLD_RUN = {
  id: 'old-1',
  title: 'fix the login bug',
  workflow: 'quick-task',
  task: 'fix the login bug',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
};

const CARD: RunCard = {
  framework: 'generic',
  frameworkHash: 'abc123',
  title: 'Tax rules engine v2',
  stage: 'plan',
  stages: { plan: 'waiting', build: 'pending', review: 'pending' },
  stageOrder: ['plan', 'build', 'review'],
  held: true,
  order: 3,
  fields: { slug: 'tax-rules', ui: false },
  blocked: { reason: 'gate', since: '2026-11-23T10:00:00.000Z' },
  frameworkState: { changeId: '2026-11-23-tax-rules', lastStatus: { discover: 'done' } },
  history: [{ at: '2026-11-23T10:00:00.000Z', text: 'created' }],
  issue: { provider: 'github', ref: '#12' },
  frameworkStateDef: { command: 'node .ai/sdd/sdd.mjs status --json', watch: '.ai/specs/*/change.json' },
  gate: { kind: 'framework', approve: 'spec' },
  conversation: false,
};

describe('RunStore — card field', () => {
  let dataDir: string;
  const stores: RunStore[] = [];
  const open = () => {
    const s = RunStore.open(dataDir);
    stores.push(s);
    return s;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-card-'));
  });
  afterEach(() => {
    for (const s of stores) clearTimeout((s as unknown as { saveTimer: NodeJS.Timeout | null }).saveTimer ?? undefined);
    stores.length = 0;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists a card and reads it back', () => {
    const store = open();
    const run = store.createRun({ title: 'card', workflow: 'framework:generic', task: 'card', steps: [] });
    store.updateRun(run.id, { card: CARD });
    store.flush();
    expect(open().getRun(run.id)?.card).toEqual(CARD);
  });

  it('parses an old runs.json with no card field, and writes none back', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([OLD_RUN]), 'utf8');
    const store = open();
    expect(store.getRun(OLD_RUN.id)?.card).toBeUndefined();
    store.createRun({ title: 'ad-hoc', workflow: 'quick-task', task: 'ad-hoc', steps: [] });
    store.flush();
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).not.toContain('"card"');
  });

  it('drops a corrupt card to an ad-hoc run instead of losing the record', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([{ ...OLD_RUN, card: { framework: 7 } }]), 'utf8');
    const run = open().getRun(OLD_RUN.id);
    expect(run?.title).toBe(OLD_RUN.title);
    expect(run?.card).toBeUndefined();
  });
});

describe('cardNotStarted', () => {
  it('is queued with no graph cursor; a card re-queued mid-walk has started', () => {
    expect(cardNotStarted({ status: 'queued' })).toBe(true);
    expect(cardNotStarted({ status: 'queued', graphState: {} })).toBe(true);
    expect(cardNotStarted({ status: 'queued', graphState: { cursor: 'spec-agent' } })).toBe(false);
    expect(cardNotStarted({ status: 'waiting' })).toBe(false);
  });
});
