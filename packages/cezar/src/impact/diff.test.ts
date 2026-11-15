import { describe, expect, it } from 'vitest';
import { changeCount, diffReviewModels, type ModelChangeKind } from './diff.ts';
import type { ReviewModel } from './model.ts';
import { loadDemoReview } from './render.ts';

const demo = () => structuredClone(loadDemoReview()) as ReviewModel;
type Edit = (m: ReviewModel) => void;
const flow = (m: ReviewModel) => m.flows[0]!;

// One row per id-bearing collection: [kind, id, add, change, remove].
const table: Array<[ModelChangeKind, string, Edit, Edit, Edit]> = [
  ['summary', 'summary', () => {}, (m) => void (m.scope_note = 'Narrower scope'), () => {}],
  ['decision', 'decision', () => {}, (m) => void (m.decision.rationale = 'Changed reasoning'), () => {}],
  [
    'condition',
    'cond-new',
    (m) => void m.decision.conditions.push({ ...m.decision.conditions[0]!, id: 'cond-new' }),
    (m) => void (m.decision.conditions[0]!.owner = 'Someone else'),
    (m) => void m.decision.conditions.splice(0, 1),
  ],
  [
    'capability',
    'cap-new',
    (m) => void m.capabilities.push({ ...m.capabilities[0]!, id: 'cap-new' }),
    (m) => void (m.capabilities[0]!.title = 'Renamed capability'),
    (m) => void m.capabilities.splice(0, 1),
  ],
  [
    'node',
    'n-new',
    (m) => void m.architecture.nodes.push({ ...m.architecture.nodes[0]!, id: 'n-new' }),
    (m) => void (m.architecture.nodes[0]!.status = 'removed'),
    (m) => void m.architecture.nodes.splice(0, 1),
  ],
  [
    'edge',
    'e-new',
    (m) => void m.architecture.edges.push({ ...m.architecture.edges[0]!, id: 'e-new' }),
    (m) => void (m.architecture.edges[0]!.label = 'calls differently'),
    (m) => void m.architecture.edges.splice(0, 1),
  ],
  [
    'view',
    'v-new',
    (m) => void m.architecture.views.push({ ...m.architecture.views[0]!, id: 'v-new' }),
    (m) => void (m.architecture.views[0]!.places[0]!.col = (m.architecture.views[0]!.places[0]!.col + 1) % 3),
    (m) => void m.architecture.views.splice(0, 1),
  ],
  [
    'flow',
    'f-new',
    (m) => void m.flows.push({ ...flow(m), id: 'f-new', before: { steps: [], links: [] }, after: { steps: [], links: [] } }),
    (m) => void (flow(m).outcome = 'A different outcome'),
    (m) => void m.flows.splice(1, 1),
  ],
  [
    'flow-step',
    'authorize/after/a9',
    (m) => void flow(m).after.steps.push({ ...flow(m).after.steps[0]!, id: 'a9' }),
    (m) => void (flow(m).after.steps[0]!.label = 'Renamed step'),
    (m) => void flow(m).after.steps.splice(0, 1),
  ],
  [
    'api',
    'api-new',
    (m) => void m.api_changes.push({ ...m.api_changes[0]!, id: 'api-new' }),
    (m) => void (m.api_changes[0]!.breaking = 'unknown'),
    (m) => void m.api_changes.splice(0, 1),
  ],
  [
    'tradeoff',
    't-new',
    (m) => void m.tradeoffs.push({ ...m.tradeoffs[0]!, id: 't-new' }),
    (m) => void (m.tradeoffs[0]!.con = 'Costs more'),
    (m) => void m.tradeoffs.splice(0, 1),
  ],
  [
    'fit',
    'fit-new',
    (m) => void m.fit.push({ ...m.fit[0]!, id: 'fit-new' }),
    (m) => void (m.fit[0]!.status = 'tension'),
    (m) => void m.fit.splice(0, 1),
  ],
  [
    'question',
    'q-new',
    (m) => void m.questions.push({ ...m.questions[0]!, id: 'q-new' }),
    (m) => void (m.questions[0]!.why = 'Because'),
    (m) => void m.questions.splice(0, 1),
  ],
];

describe('diffReviewModels', () => {
  it('an unchanged model has no changes', () => {
    const diff = diffReviewModels(demo(), demo());
    expect(diff).toEqual({ added: [], changed: [], removed: [] });
    expect(changeCount(diff)).toBe(0);
  });

  it.each(table)('%s: added, changed and removed by id', (kind, newId, add, change, remove) => {
    const changed = demo();
    change(changed);
    const diff = diffReviewModels(demo(), changed);
    expect(diff.changed.map((c) => c.kind)).toEqual([kind]);
    expect(diff.added.concat(diff.removed)).toEqual([]);
    if (kind === 'summary' || kind === 'decision') return; // singletons are never added or removed
    const grown = demo();
    add(grown);
    const added = diffReviewModels(demo(), grown);
    expect(added.added.map((c) => [c.kind, c.id])).toEqual([[kind, newId]]);
    expect(added.changed.concat(added.removed)).toEqual([]);
    // The same pair the other way round is a removal.
    expect(diffReviewModels(grown, demo()).removed.map((c) => [c.kind, c.id])).toEqual([[kind, newId]]);
    const shrunk = demo();
    remove(shrunk);
    const removed = diffReviewModels(demo(), shrunk).removed.filter((c) => c.kind === kind);
    expect(removed).toHaveLength(1);
  });

  it('removing an existing element lists it with its label', () => {
    const next = demo();
    const [gone] = next.capabilities.splice(0, 1);
    expect(diffReviewModels(demo(), next).removed).toEqual([{ kind: 'capability', id: gone!.id, label: gone!.title }]);
  });

  it('arrays are sets and sibling order is not a change; the derived home_view is ignored', () => {
    const next = demo();
    next.capabilities.reverse();
    next.capabilities[0]!.evidence.reverse();
    next.capabilities[0]!.components.reverse();
    next.capabilities[0]!.home_view = 'somewhere';
    next.architecture.views[0]!.places.reverse();
    flow(next).after.links.reverse();
    expect(changeCount(diffReviewModels(demo(), next))).toBe(0);
  });

  it('a flow step change does not mark its flow, and a condition change does not mark the decision', () => {
    const next = demo();
    flow(next).before.steps[0]!.label = 'Renamed';
    next.decision.conditions[0]!.title = 'Renamed';
    expect(diffReviewModels(demo(), next).changed.map((c) => `${c.kind}:${c.id}`)).toEqual([
      'condition:cond-key-port',
      'flow-step:authorize/before/b1',
    ]);
  });

  it('labels an edge by its endpoints and a flow step by its flow', () => {
    const next = demo();
    next.architecture.edges[0]!.label = 'x';
    flow(next).after.steps[0]!.status = 'removed';
    const changed = diffReviewModels(demo(), next).changed;
    const nodes = new Map(demo().architecture.nodes.map((n) => [n.id, n.label]));
    const e = demo().architecture.edges[0]!;
    expect(changed[0]).toEqual({ kind: 'edge', id: e.id, label: `${nodes.get(e.from)} → ${nodes.get(e.to)}` });
    expect(changed[1]!.label).toBe(`${flow(demo()).title} · ${flow(demo()).after.steps[0]!.label}`);
  });
});
