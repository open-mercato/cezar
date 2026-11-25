import { describe, expect, it } from 'vitest';
import { frameworkFileSchema, type FrameworkFile } from '@open-mercato/cezar-contract';
import { graphIssues, workflowGraphSchema } from '../workflows/graph.ts';
import { BUILTIN_FRAMEWORK_YAML } from './builtins.ts';
import { compileFramework, compiledStages, resolveCardFields, slugify } from './compile.ts';
import { listBuiltinFrameworks, parseFrameworkYaml } from './load.ts';

const builtin = (id: string): FrameworkFile => {
  const f = listBuiltinFrameworks().find((x) => x.id === id);
  if (!f?.framework) throw new Error(`built-in ${id} did not load: ${f?.error}`);
  return f.framework;
};

const CARD = { title: 'Tax rules engine v2', brief: 'Rates per region.', fields: {} };

describe('compileFramework — golden graphs per built-in', () => {
  for (const { id } of BUILTIN_FRAMEWORK_YAML) {
    it(`${id} compiles to a sound graph that matches its golden file`, async () => {
      const graph = compileFramework(builtin(id), CARD);
      expect(workflowGraphSchema.safeParse(graph).success).toBe(true);
      expect(graphIssues(graph, { frameworkNodes: true })).toEqual([]);
      // Every node is tagged with its stage (spec § Compilation).
      for (const n of graph.nodes) expect(n.stage, n.id).toBeTruthy();
      await expect(JSON.stringify(graph, null, 2)).toMatchFileSnapshot(`./__golden__/${id}.graph.json`);
    });
  }

  it('every built-in parses with no error', () => {
    for (const f of listBuiltinFrameworks()) expect(f.error, f.id).toBeUndefined();
  });
});

describe('compileFramework — shape', () => {
  it('generic: Plan approve gate rejects back into Plan; Review changes loops to Build', () => {
    const graph = compileFramework(builtin('generic'), CARD);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['plan-enter', 'plan-agent', 'plan-exit', 'plan-gate', 'build-agent', 'review-agent', 'review-changes-loop']));
    expect(graph.edges).toContainEqual({ from: 'plan-reject-loop.repeat', to: 'plan-enter' });
    expect(graph.edges).toContainEqual({ from: 'review-changes-loop.repeat', to: 'build-enter' });
    expect(graph.edges).toContainEqual({ from: 'review-agent.approve', to: 'end' });
    const exit = graph.nodes.find((n) => n.id === 'plan-exit');
    expect(exit).toMatchObject({ type: 'stage.exit', artifacts: ['.ai/cezar/plans/tax-rules-engine-v2.md'] });
  });

  it('open-mercato-sdd: framework gates, WIP, run-gate check loop, verify → implement', () => {
    const graph = compileFramework(builtin('open-mercato-sdd'), CARD);
    expect(graph.nodes.find((n) => n.id === 'spec-gate')).toMatchObject({ type: 'gate.framework', stage: 'spec', approve: 'spec' });
    expect(graph.nodes.find((n) => n.id === 'discover-gate')).toMatchObject({ type: 'gate.framework', approve: null });
    expect(graph.nodes.find((n) => n.id === 'discover-agent')).toMatchObject({ mode: 'conversation', skill: 'om-sdd-discover' });
    expect(graph.nodes.find((n) => n.id === 'implement-enter')).toMatchObject({ wip: 2, precheck: 'node .ai/sdd/sdd.mjs gate implement' });
    expect(graph.edges).toContainEqual({ from: 'implement-check.fail', to: 'implement-check-loop' });
    expect(graph.edges).toContainEqual({ from: 'implement-check-loop.repeat', to: 'implement-agent' });
    expect(graph.edges).toContainEqual({ from: 'verify-fail-loop.repeat', to: 'implement-enter' });
    expect(graph.edges).toContainEqual({ from: 'validate-no-go-loop.repeat', to: 'spec-enter' });
    const prompt = (graph.nodes.find((n) => n.id === 'spec-agent') as { prompt: string }).prompt;
    expect(prompt).toContain("Never run the framework's approve command yourself");
    expect(prompt).toContain('Tax rules engine v2');
    // A missing framework file is reported, never improvised (the Discover-without-SDD bug).
    const discover = (graph.nodes.find((n) => n.id === 'discover-agent') as { prompt: string }).prompt;
    expect(discover).toContain('`.ai/sdd/sdd.mjs`, `.ai/sdd/CONVENTIONS.md`');
    expect(discover).toContain('stop and report it with CEZ:ASK');
    const generic = compileFramework(builtin('generic'), CARD).nodes.find((n) => n.id === 'plan-agent') as { prompt: string };
    expect(generic.prompt).not.toContain('CEZ:ASK');
  });

  it('skips by startAt, skip list and skipUnless; back edges retarget past a skipped stage', () => {
    const fw = builtin('open-mercato-sdd');
    const card = { ...CARD, fields: { ui: false }, startAt: 'spec', skip: ['secure'] };
    expect(compiledStages(fw, card).skipped).toEqual(['discover', 'mockup', 'secure']);
    const graph = compileFramework(fw, card);
    expect(graph.nodes.some((n) => n.stage === 'mockup' || n.stage === 'discover')).toBe(false);
    expect(graph.edges).toContainEqual({ from: 'start.next', to: 'spec-enter' });
    expect(graph.edges).toContainEqual({ from: 'spec-gate.approve', to: 'validate-enter' });
    expect(graphIssues(graph, { frameworkNodes: true })).toEqual([]);

    const noSpec = compileFramework(fw, { ...CARD, skip: ['spec'] });
    // validate's no-go targets spec, which is skipped → the first compiled stage after it.
    expect(noSpec.edges).toContainEqual({ from: 'validate-no-go-loop.repeat', to: 'mockup-enter' });
  });

  it('autonomous cards compile conversation stages without mode, and say so in the prompt', () => {
    const graph = compileFramework(builtin('open-mercato-sdd'), { ...CARD, autonomous: true });
    const agent = graph.nodes.find((n) => n.id === 'discover-agent') as { mode?: string; prompt: string };
    expect(agent.mode).toBeUndefined();
    expect(agent.prompt).toContain('do not wait for answers');
  });

  it('applies per-stage model and runner overrides', () => {
    const graph = compileFramework(builtin('generic'), { ...CARD, overrides: { build: { model: 'gpt-5', runner: 'codex' } } });
    expect(graph.nodes.find((n) => n.id === 'build-agent')).toMatchObject({ model: 'gpt-5', runner: 'codex' });
  });

  it('command stages put the slash command first in the prompt', () => {
    const graph = compileFramework(builtin('openspec'), CARD);
    const prompt = (graph.nodes.find((n) => n.id === 'apply-agent') as { prompt: string }).prompt;
    expect(prompt.startsWith('/openspec:apply Tax rules engine v2')).toBe(true);
  });

  it('session.continue reopens an earlier stage agent', () => {
    const fw = frameworkFileSchema.parse({
      id: 'x', name: 'X',
      stages: [{ id: 'a', skill: 's' }, { id: 'b', skill: 's', session: { continue: 'a' } }],
    });
    const graph = compileFramework(fw, CARD);
    expect(graph.nodes.find((n) => n.id === 'b-agent')).toMatchObject({ session: { continue: 'a-agent' } });
    expect(graphIssues(graph, { frameworkNodes: true })).toEqual([]);
  });

  it('resolves card fields: explicit wins, from:title slugifies, boolean defaults', () => {
    const fw = builtin('open-mercato-sdd');
    expect(resolveCardFields(fw, 'Tax Rules!', {})).toEqual({ slug: 'tax-rules', ui: true });
    expect(resolveCardFields(fw, 'Tax Rules!', { slug: 'mine', ui: false })).toEqual({ slug: 'mine', ui: false });
    expect(slugify('  ')).toBe('card');
  });
});

describe('framework file schema', () => {
  const base = { id: 'x', name: 'X' };
  const issues = (doc: unknown) => {
    const r = frameworkFileSchema.safeParse(doc);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('rejects a forward onVerdict', () => {
    expect(issues({ ...base, stages: [{ id: 'a', skill: 's', verdicts: ['ok', 'redo'], onVerdict: { redo: 'b' } }, { id: 'b', skill: 's' }] }).join()).toMatch(/earlier stage/);
  });

  it('rejects unknown stage refs in onVerdict, onReject and session.continue', () => {
    expect(issues({ ...base, stages: [{ id: 'a', skill: 's', verdicts: ['ok', 'redo'], onVerdict: { redo: 'nope' } }] }).join()).toMatch(/unknown stage "nope"/);
    expect(issues({ ...base, stages: [{ id: 'a', skill: 's', gate: { kind: 'approve', onReject: 'nope' } }] }).join()).toMatch(/unknown stage "nope"/);
    expect(issues({ ...base, stages: [{ id: 'a', skill: 's', session: { continue: 'nope' } }] }).join()).toMatch(/unknown stage "nope"/);
  });

  it('rejects skill and command together', () => {
    expect(issues({ ...base, stages: [{ id: 'a', skill: 's', command: '/x' }] }).join()).toMatch(/exclusive/);
  });

  it('rejects duplicate stages, verdict-less onVerdict, all-backward verdicts, bad skipUnless, stateless framework gates', () => {
    expect(issues({ ...base, stages: [{ id: 'a' }, { id: 'a' }] }).join()).toMatch(/duplicate stage/);
    expect(issues({ ...base, stages: [{ id: 'a' }, { id: 'b', onVerdict: { x: 'a' } }] }).join()).toMatch(/needs verdicts/);
    expect(issues({ ...base, stages: [{ id: 'a' }, { id: 'b', verdicts: ['x'], onVerdict: { x: 'a' } }] }).join()).toMatch(/move forward/);
    expect(issues({ ...base, stages: [{ id: 'a', skipUnless: 'ui' }] }).join()).toMatch(/boolean card field/);
    expect(issues({ ...base, stages: [{ id: 'a', gate: { kind: 'framework', approve: null } }] }).join()).toMatch(/state.command/);
    expect(issues({ ...base, stages: [{ id: 'a', verdicts: ['done'] }] }).join()).toMatch(/cannot be named/);
  });

  it('an unbounded back edge cannot be written: every one compiles through a loop the validator accepts', () => {
    const r = parseFrameworkYaml('id: x\nname: X\nstages:\n  - { id: a, skill: s }\n  - { id: b, skill: s, verdicts: [ok, redo], onVerdict: { redo: a } }\n');
    expect(r).toHaveProperty('framework');
  });
});
