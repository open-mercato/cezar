import type { FrameworkFile, FrameworkStage } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import type { GraphEdge, GraphNode, WorkflowGraph } from '../workflows/graph.ts';

/**
 * Framework → v2 workflow graph (spec 2026-11-15-framework-board § Compilation). Pure: the same
 * framework and card always give the same graph, which is what the golden tests pin.
 *
 * Per stage: `<s>-enter` → `<s>-agent` → checks (`<s>-check`, fail → `<s>-check-loop` → agent)
 * → `<s>-exit` (when artifacts) → `<s>-gate` → the next stage's `-enter`. Every back edge goes
 * through a loop node bounded by the stage's `loopMax`, so the graph validator proves the run finite.
 */

export type CardFieldValues = Record<string, string | boolean>;

export interface CompileCard {
  title: string;
  brief?: string;
  fields?: CardFieldValues;
  autonomous?: boolean;
  startAt?: string;
  skip?: string[];
  overrides?: Record<string, { model?: string; runner?: RunnerId }>;
}

export const DEFAULT_LOOP_MAX = 2;

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'card'
  );
}

/** The card's field values with the framework's defaults filled in (`from: title` slugifies). */
export function resolveCardFields(fw: FrameworkFile, title: string, fields: CardFieldValues = {}): CardFieldValues {
  const out: CardFieldValues = { ...fields };
  for (const f of fw.cardFields ?? []) {
    if (out[f.name] !== undefined && out[f.name] !== '') continue;
    if (f.from === 'title') out[f.name] = slugify(title);
    else if (f.default !== undefined) out[f.name] = f.default;
    else if (f.type === 'boolean') out[f.name] = false;
  }
  return out;
}

const CARD_REF_RE = /\{\{\s*card\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function renderCardRefs(text: string, fields: CardFieldValues): string {
  return text.replace(CARD_REF_RE, (_, name: string) => {
    const v = fields[name];
    return v === undefined ? '' : String(v);
  });
}

/** Which stages a card compiles (start-at, skip list, `skipUnless`), and which it skips. */
export function compiledStages(fw: FrameworkFile, card: CompileCard): { included: FrameworkStage[]; skipped: string[] } {
  const fields = resolveCardFields(fw, card.title, card.fields);
  const startIndex = card.startAt ? Math.max(0, fw.stages.findIndex((s) => s.id === card.startAt)) : 0;
  const skip = new Set(card.skip ?? []);
  const included: FrameworkStage[] = [];
  const skipped: string[] = [];
  fw.stages.forEach((s, i) => {
    const out = i < startIndex || skip.has(s.id) || (s.skipUnless !== undefined && fields[s.skipUnless] !== true);
    if (out) skipped.push(s.id);
    else included.push(s);
  });
  return { included, skipped };
}

const enterId = (stage: string) => `${stage}-enter`;
const agentId = (stage: string) => `${stage}-agent`;
const gateId = (stage: string) => `${stage}-gate`;
const checkId = (stage: string, k: number) => (k === 0 ? `${stage}-check` : `${stage}-check-${k + 1}`);

export function compileFramework(fw: FrameworkFile, card: CompileCard): WorkflowGraph {
  const fields = resolveCardFields(fw, card.title, card.fields);
  const render = (text: string) => renderCardRefs(text, fields);
  const { included } = compiledStages(fw, card);
  const includedIds = new Set(included.map((s) => s.id));
  const fwIndex = (id: string) => fw.stages.findIndex((s) => s.id === id);

  /** A back edge to a skipped stage lands on the first compiled stage after it (never past `from`). */
  const backTarget = (target: string, from: string): string => {
    const t = fwIndex(target);
    return fw.stages.find((s, i) => i >= t && includedIds.has(s.id))?.id ?? from;
  };
  /** Which stage an approve gate's Request changes reopens: `onReject`, else the previous stage. */
  const rejectTarget = (s: FrameworkStage, i: number): string => {
    if (s.gate?.kind !== 'approve') return s.id;
    if (s.gate.onReject) return backTarget(s.gate.onReject, s.id);
    return included[i - 1]?.id ?? s.id;
  };

  const first = included[0]?.id;
  const last = included[included.length - 1]?.id;
  const nodes: GraphNode[] = [{ id: 'start', type: 'start', ...(first ? { stage: first } : {}) }];
  const edges: GraphEdge[] = [];
  let tails = ['start.next'];
  const wire = (to: string) => {
    for (const from of tails) edges.push({ from, to });
  };

  included.forEach((s, i) => {
    const loopMax = s.loopMax ?? DEFAULT_LOOP_MAX;
    const stage = s.id;
    const conversation = s.mode === 'conversation' && !card.autonomous;
    const override = card.overrides?.[stage];
    const model = override?.model ?? s.model;
    const runner = override?.runner ?? s.runner;
    const continued = s.session && s.session !== 'fresh' && includedIds.has(s.session.continue) ? s.session.continue : undefined;
    // Gates whose Request changes reopen this stage, so its prompt can carry the reviewer's comment.
    const rejectedBy = included.filter((g, gi) => g.gate?.kind === 'approve' && rejectTarget(g, gi) === stage).map((g) => gateId(g.id));

    nodes.push({
      id: enterId(stage),
      type: 'stage.enter',
      stage,
      ...(s.wip ? { wip: s.wip } : {}),
      ...(s.precheck ? { precheck: render(s.precheck) } : {}),
    });
    wire(enterId(stage));

    nodes.push({
      id: agentId(stage),
      type: 'agent',
      stage,
      name: s.name ?? stage,
      prompt: stagePrompt(fw, s, i, included.length, card, fields, render, rejectedBy),
      ...(s.skill ? { skill: s.skill } : {}),
      ...(model ? { model } : {}),
      ...(runner ? { runner } : {}),
      ...(s.verdicts ? { verdicts: [...s.verdicts] } : {}),
      ...(continued ? { session: { continue: agentId(continued) } } : {}),
      ...(conversation ? { mode: 'conversation' as const } : {}),
    });
    edges.push({ from: `${enterId(stage)}.next`, to: agentId(stage) });

    const back = Object.entries(s.onVerdict ?? {});
    tails = s.verdicts ? s.verdicts.filter((v) => !s.onVerdict?.[v]).map((v) => `${agentId(stage)}.${v}`) : [`${agentId(stage)}.done`];
    for (const [verdict, target] of back) {
      const loop = `${stage}-${verdict}-loop`;
      nodes.push({ id: loop, type: 'loop', stage, max: loopMax });
      edges.push({ from: `${agentId(stage)}.${verdict}`, to: loop }, { from: `${loop}.repeat`, to: enterId(backTarget(target, stage)) });
    }

    (s.checks ?? []).forEach((command, k) => {
      const id = checkId(stage, k);
      nodes.push({ id, type: 'check', stage, command: render(command) });
      wire(id);
      tails = [`${id}.pass`];
      const loop = `${stage}-check-loop`;
      if (k === 0) {
        nodes.push({ id: loop, type: 'loop', stage, max: loopMax });
        edges.push({ from: `${loop}.repeat`, to: agentId(stage) });
      }
      edges.push({ from: `${id}.fail`, to: loop });
    });

    if (s.artifacts?.length) {
      const id = `${stage}-exit`;
      nodes.push({ id, type: 'stage.exit', stage, artifacts: s.artifacts.map(render) });
      wire(id);
      tails = [`${id}.pass`];
    }

    if (s.gate?.kind === 'approve') {
      const id = gateId(stage);
      const loop = `${stage}-reject-loop`;
      nodes.push({ id, type: 'gate.human', stage, message: render(s.gate.message ?? `Approve "${s.name ?? stage}" for this card?`) });
      nodes.push({ id: loop, type: 'loop', stage, max: loopMax });
      wire(id);
      edges.push({ from: `${id}.reject`, to: loop }, { from: `${loop}.repeat`, to: enterId(rejectTarget(s, i)) });
      tails = [`${id}.approve`];
    } else if (s.gate?.kind === 'framework') {
      const id = gateId(stage);
      nodes.push({ id, type: 'gate.framework', stage, approve: s.gate.approve });
      wire(id);
      tails = [`${id}.approve`];
    }
  });

  // Ship is not compiled: the run's own review gate follows `end` (spec § Compilation).
  nodes.push({ id: 'end', type: 'end', status: 'success', ...(last ? { stage: last } : {}) });
  wire('end');
  return { nodes, edges };
}

function stagePrompt(
  fw: FrameworkFile,
  s: FrameworkStage,
  index: number,
  total: number,
  card: CompileCard,
  fields: CardFieldValues,
  render: (text: string) => string,
  rejectedBy: string[],
): string {
  const name = s.name ?? s.id;
  const parts: string[] = [s.command ? `${s.command} ${card.title}` : `# ${card.title}`];
  if (card.brief?.trim()) parts.push(card.brief.trim());
  parts.push(
    `You are working on stage ${index + 1}/${total} "${name}" of the ${fw.name} framework` +
      (s.skill ? `; follow the \`${s.skill}\` skill.` : '.'),
  );
  if (s.description) parts.push(render(s.description));
  const requires = fw.requires ?? fw.detect ?? [];
  if (requires.length) {
    parts.push(`${fw.name} needs ${requires.map((p) => `\`${p}\``).join(', ')} on this branch. If a framework file this stage relies on is missing, stop and report it with CEZ:ASK — never improvise the framework's steps or files by hand.`);
  }
  const fieldLines = Object.entries(fields).map(([k, v]) => `- ${k}: ${String(v)}`);
  if (fieldLines.length) parts.push(`Card fields:\n${fieldLines.join('\n')}`);
  if (s.artifacts?.length) parts.push(`This stage must leave these files (checked when you finish):\n${s.artifacts.map((a) => `- ${render(a)}`).join('\n')}`);
  if (s.checks?.length) {
    parts.push(`These checks run after you finish:\n${s.checks.map((c) => `- ${render(c)}`).join('\n')}`);
    parts.push(`If a check failed on the previous attempt, its output:\n{{nodes.${checkId(s.id, 0)}.output}}`);
  }
  if (s.review) parts.push('You are the reviewer: judge the work on this branch. Do not change the implementation.');
  if (s.gate?.kind === 'framework') {
    parts.push("A person approves this stage. Never run the framework's approve command yourself.");
  } else if (s.gate?.kind === 'approve') {
    parts.push("A person reviews this stage's result before the card moves on.");
  }
  if (s.mode === 'conversation' && card.autonomous) {
    parts.push('This card runs unattended: do not wait for answers. Decide, and list every assumption you made at the end.');
  }
  for (const gate of rejectedBy) parts.push(`If a reviewer asked for changes, their comment:\n{{nodes.${gate}.comment}}`);
  return parts.join('\n\n');
}
