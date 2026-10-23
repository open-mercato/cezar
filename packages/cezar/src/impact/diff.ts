/**
 * "What changed" between two report versions (spec 2026-10-22-html-artifacts-and-impact, R4):
 * every id-bearing element of the review model, compared by id. Pure — no I/O, no clock.
 */
import type { ReviewModel } from './model.ts';

/** The report's own `data-kind` vocabulary, plus the two singletons and views. */
export type ModelChangeKind =
  | 'summary'
  | 'decision'
  | 'condition'
  | 'capability'
  | 'node'
  | 'edge'
  | 'view'
  | 'flow'
  | 'flow-step'
  | 'api'
  | 'tradeoff'
  | 'fit'
  | 'question';

/** `id` is the element's `data-ref` in the report (a flow step's is `<flow>/<side>/<step>`). */
export interface ModelChange {
  kind: ModelChangeKind;
  id: string;
  label: string;
}

export interface ModelDiff {
  added: ModelChange[];
  changed: ModelChange[];
  removed: ModelChange[];
}

interface Entry extends ModelChange {
  value: unknown;
}

/**
 * Every array is compared as a set (evidence refs, components, places, links all are), and a
 * sibling's position in its collection is never a change; derived `home_view` is ignored.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => JSON.stringify(canonical(v))).sort();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

function entries(m: ReviewModel): Entry[] {
  const nodeLabel = new Map(m.architecture.nodes.map((n) => [n.id, n.label]));
  const label = (id: string) => nodeLabel.get(id) ?? id;
  const { conditions, ...decision } = m.decision;
  const out: Entry[] = [
    { kind: 'summary', id: 'summary', label: 'Summary', value: { summary: m.summary, scope_note: m.scope_note } },
    { kind: 'decision', id: 'decision', label: m.decision.label, value: decision },
  ];
  for (const c of conditions) out.push({ kind: 'condition', id: c.id, label: c.title, value: c });
  for (const { home_view: _derived, ...c } of m.capabilities) out.push({ kind: 'capability', id: c.id, label: c.title, value: c });
  for (const n of m.architecture.nodes) out.push({ kind: 'node', id: n.id, label: n.label, value: n });
  for (const e of m.architecture.edges) out.push({ kind: 'edge', id: e.id, label: `${label(e.from)} → ${label(e.to)}`, value: e });
  for (const v of m.architecture.views) out.push({ kind: 'view', id: v.id, label: v.title, value: v });
  for (const f of m.flows) {
    // Steps are elements of their own; the flow keeps its text and its links.
    const { before, after, ...rest } = f;
    out.push({ kind: 'flow', id: f.id, label: f.title, value: { ...rest, before: before.links, after: after.links } });
    for (const [side, diagram] of [['before', before], ['after', after]] as const) {
      for (const s of diagram.steps) out.push({ kind: 'flow-step', id: `${f.id}/${side}/${s.id}`, label: `${f.title} · ${s.label}`, value: s });
    }
  }
  for (const a of m.api_changes) out.push({ kind: 'api', id: a.id, label: a.name, value: a });
  for (const t of m.tradeoffs) out.push({ kind: 'tradeoff', id: t.id, label: t.title, value: t });
  for (const f of m.fit) out.push({ kind: 'fit', id: f.id, label: f.title, value: f });
  for (const q of m.questions) out.push({ kind: 'question', id: q.id, label: q.question, value: q });
  return out;
}

const key = (e: ModelChange) => `${e.kind}\u0000${e.id}`;
const strip = ({ kind, id, label }: Entry): ModelChange => ({ kind, id, label });

/** Added, changed and removed elements of `next` against `prev`, each in model order. */
export function diffReviewModels(prev: ReviewModel, next: ReviewModel): ModelDiff {
  const before = new Map(entries(prev).map((e) => [key(e), e]));
  const after = entries(next);
  const seen = new Set<string>();
  const diff: ModelDiff = { added: [], changed: [], removed: [] };
  for (const entry of after) {
    const k = key(entry);
    seen.add(k);
    const old = before.get(k);
    if (!old) diff.added.push(strip(entry));
    else if (JSON.stringify(canonical(old.value)) !== JSON.stringify(canonical(entry.value))) diff.changed.push(strip(entry));
  }
  for (const [k, entry] of before) if (!seen.has(k)) diff.removed.push(strip(entry));
  return diff;
}

export function changeCount(diff: ModelDiff): number {
  return diff.added.length + diff.changed.length + diff.removed.length;
}
