import { describe, it, expect } from 'vitest';
import { IssueStore, contentHash, type Store, type StorePort } from '@cezar/core';

function makeIssue(number: number) {
  const title = `Issue ${number}`;
  const body = `Body ${number}`;
  return {
    number,
    title,
    body,
    state: 'open' as const,
    labels: [],
    author: 'user1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    contentHash: contentHash(title, body),
    commentCount: 0,
    reactions: 0,
    comments: [],
    commentsFetchedAt: null,
    digest: null,
    analysis: {},
  };
}

const snapshot: Store = {
  meta: {
    owner: 'acme',
    repo: 'widgets',
    lastSyncedAt: null,
    totalFetched: 0,
    version: 1,
    orgMembers: [],
    orgMembersFetchedAt: null,
  },
  issues: [],
};

describe('IssueStore.fromData', () => {
  it('builds an in-memory store from a snapshot', () => {
    const store = IssueStore.fromData(snapshot);
    expect(store.getMeta().owner).toBe('acme');
    expect(store.getAllData().issues).toEqual([]);
  });

  it('routes save() to onSave when provided', async () => {
    let saved: Store | null = null;
    const store = IssueStore.fromData(snapshot, { onSave: async (d) => { saved = d; } });
    store.updateMeta({ totalFetched: 3 });
    await store.save();
    expect(saved).not.toBeNull();
    expect(saved!.meta.totalFetched).toBe(3);
  });

  it('save() is a no-op without onSave', async () => {
    const store = IssueStore.fromData(snapshot);
    await expect(store.save()).resolves.toBeUndefined();
  });
});

describe('IssueStore.fromPort concurrent save', () => {
  // A mutable in-memory port standing in for Supabase/file: load() returns the
  // current backing state so save() can re-read and merge.
  function makePort(initial: Store): StorePort & { state: Store } {
    return {
      state: structuredClone(initial),
      async load() { return structuredClone(this.state); },
      async save(d) { this.state = structuredClone(d); },
    };
  }

  it('does not clobber a concurrent run that wrote a different issue', async () => {
    const backing: Store = {
      meta: { owner: 'acme', repo: 'widgets', lastSyncedAt: null, totalFetched: 0, version: 1, orgMembers: [], orgMembersFetchedAt: null },
      issues: [makeIssue(1), makeIssue(2)],
    };
    const port = makePort(backing);

    // Both runs load the same snapshot.
    const runA = await IssueStore.fromPort(port);
    const runB = await IssueStore.fromPort(port);

    // Run B writes analysis on issue #2 and saves first.
    runB.setAnalysis(2, { priority: 'high' });
    await runB.save();

    // Run A (stale snapshot) writes analysis on issue #1 and saves second.
    runA.setAnalysis(1, { priority: 'low' });
    await runA.save();

    // Both writes must survive.
    expect(port.state.issues.find((i) => i.number === 2)!.analysis.priority).toBe('high');
    expect(port.state.issues.find((i) => i.number === 1)!.analysis.priority).toBe('low');
  });

  it('preserves an issue only the concurrent run added', async () => {
    const backing: Store = {
      meta: { owner: 'acme', repo: 'widgets', lastSyncedAt: null, totalFetched: 0, version: 1, orgMembers: [], orgMembersFetchedAt: null },
      issues: [makeIssue(1)],
    };
    const port = makePort(backing);

    const runA = await IssueStore.fromPort(port);

    // A concurrent run adds issue #2 after A loaded.
    port.state.issues.push(makeIssue(2));

    runA.setAnalysis(1, { priority: 'low' });
    await runA.save();

    expect(port.state.issues.map((i) => i.number).sort()).toEqual([1, 2]);
  });
});
