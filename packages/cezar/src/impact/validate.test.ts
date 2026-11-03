import { describe, expect, it } from 'vitest';
import { MAX_PER_VIEW, type ReviewModel } from './model.ts';
import { readFileSync } from 'node:fs';
import { formatIssue, validateReview } from './validate.ts';

// Every rule of render_cockpit.py validate(), plus the v4 api_changes and model-wide id rules
// (spec 2026-10-22-html-artifacts-and-impact, Q7 / R3 / R4). One row per rule.
const demoJson = readFileSync(new URL('./demo-review.json', import.meta.url), 'utf8');
const demo = () => JSON.parse(demoJson) as ReviewModel;
// Loosely typed handle for mutations the schema would not allow at compile time.
type Loose = Record<string, any>;

function issuesOf(model: unknown): string[] {
  const result = validateReview(model);
  return result.ok ? [] : result.issues.map(formatIssue);
}

const realReview = (m: ReviewModel) => {
  m.meta.demo = false;
  m.evidence.forEach((e) => (e.kind = 'observed'));
};

const rows: Array<[string, (m: Loose) => void, RegExp]> = [
  // ---- shape (zod) ----
  ['schema_version must be 4', (m) => (m.schema_version = 3), /^schema_version: schema_version must be 4/],
  ['meta text fields are nonempty', (m) => (m.meta.title = '  '), /^meta\.title: nonempty string required/],
  ['meta.demo must be boolean', (m) => (m.meta.demo = 'yes'), /^meta\.demo: /],
  ['meta.subject_kind is pr|spec', (m) => (m.meta.subject_kind = 'issue'), /^meta\.subject_kind: /],
  ['summary required', (m) => (m.summary = ''), /^summary: nonempty string required/],
  ['scope_note required', (m) => delete m.scope_note, /^scope_note: /],
  ['capabilities cannot be empty', (m) => (m.capabilities = []), /capabilities cannot be empty/],
  ['flows cannot be empty', (m) => (m.flows = []), /flows cannot be empty/],
  ['fit cannot be empty', (m) => (m.fit = []), /fit cannot be empty/],
  ['evidence cannot be empty', (m) => (m.evidence = []), /evidence cannot be empty/],
  ['tradeoffs must be a list', (m) => (m.tradeoffs = {}), /^tradeoffs: /],
  ['questions must be a list', (m) => (m.questions = 'none'), /^questions: /],
  ['api_changes must be a list', (m) => delete m.api_changes, /^api_changes: /],
  ['unknown keys are refused (typos surface)', (m) => (m.capabilities[0].componets = []), /^capabilities\[0\]: .*componets/],
  ['invalid evidence kind', (m) => (m.evidence[0].kind = 'certain'), /^evidence\[0\]\.kind: /],
  ['decision text fields', (m) => (m.decision.rationale = ''), /^decision\.rationale: nonempty/],
  ['decision evidence required', (m) => (m.decision.evidence = []), /^decision\.evidence: evidence required/],
  ['decision.conditions must be a list', (m) => (m.decision.conditions = null), /^decision\.conditions: /],
  ['condition text fields', (m) => (m.decision.conditions[0].owner = ''), /^decision\.conditions\[0\]\.owner: /],
  ['architecture headline', (m) => (m.architecture.headline = ''), /^architecture\.headline: /],
  ['architecture.nodes required', (m) => (m.architecture.nodes = []), /architecture\.nodes required/],
  ['architecture.edges must be a list', (m) => delete m.architecture.edges, /^architecture\.edges: /],
  ['invalid node status', (m) => (m.architecture.nodes[0].status = 'new'), /^architecture\.nodes\[0\]\.status: /],
  ['node text fields', (m) => (m.architecture.nodes[0].impact = ''), /^architecture\.nodes\[0\]\.impact: /],
  ['views: 1..8 diagram sections (too many)', (m) => (m.architecture.views = Array(5).fill(m.architecture.views).flat()), /1\.\.8 diagram sections/],
  ['views: 1..8 diagram sections (none)', (m) => (m.architecture.views = []), /1\.\.8 diagram sections/],
  ['view text fields', (m) => (m.architecture.views[0].before_caption = ''), /^architecture\.views\[0\]\.before_caption: /],
  ['places needs at least two components', (m) => m.architecture.views[0].places.splice(1), /places needs at least two components/],
  ['place col must be 0..2', (m) => (m.architecture.views[0].places[0].col = 3), /Place col must be 0\.\.2/],
  ['place row must be 0..9', (m) => (m.architecture.views[0].places[0].row = 10), /Place row must be 0\.\.9/],
  ['place col must be an integer', (m) => (m.architecture.views[0].places[0].col = 0.5), /places\[0\]\.col: /],
  ['invalid edge status', (m) => (m.architecture.edges[0].status = 'moved'), /^architecture\.edges\[0\]\.status: /],
  ['invalid capability status (unchanged)', (m) => (m.capabilities[0].status = 'unchanged'), /^capabilities\[0\]\.status: /],
  ['capability components required', (m) => (m.capabilities[0].components = []), /Capability components required/],
  ['flow steps required', (m) => (m.flows[0].after.steps = []), /Flow steps required/],
  ['flow links must be a list', (m) => delete m.flows[0].before.links, /^flows\[0\]\.before\.links: /],
  ['flow before required', (m) => delete m.flows[0].before, /^flows\[0\]\.before: /],
  ['invalid step status', (m) => (m.flows[0].after.steps[0].status = 'x'), /steps\[0\]\.status: /],
  ['invalid fit status', (m) => (m.fit[0].status = 'great'), /^fit\[0\]\.status: /],
  ['tradeoff text fields', (m) => (m.tradeoffs[0].alternative = ''), /^tradeoffs\[0\]\.alternative: /],
  ['question text fields', (m) => (m.questions[0].why = ''), /^questions\[0\]\.why: /],
  ['api change surface', (m) => (m.api_changes[0].surface = 'graphql'), /^api_changes\[0\]\.surface: /],
  ['api change breaking is true|false|unknown', (m) => (m.api_changes[0].breaking = 'maybe'), /^api_changes\[0\]\.breaking: /],
  // ---- evidence ----
  ['duplicate evidence ID', (m) => m.evidence.push({ ...m.evidence[0] }), /Duplicate evidence ID D1/],
  ['demo evidence only in a demo (test_real_report_rejects_demo_provenance)', (m) => (m.meta.demo = false), /Demo evidence cannot appear in a real review/],
  ['javascript: url refused', (m) => (m.evidence[0].url = 'javascript:alert(1)'), /credential-free HTTPS/],
  ['http: url refused', (m) => (m.evidence[0].url = 'http://example.org'), /credential-free HTTPS/],
  ['url with credentials refused', (m) => (m.evidence[0].url = 'https://name:secret@example.org'), /credential-free HTTPS/],
  ['unresolved evidence (test_broken_evidence_rejected)', (m) => (m.capabilities[0].evidence = ['missing']), /^capabilities\[0\]\.evidence\[0\]: unresolved evidence missing/],
  ['condition evidence resolves', (m) => (m.decision.conditions[0].evidence = ['nope']), /^decision\.conditions\[0\]\.evidence\[0\]: unresolved/],
  ['decision evidence resolves', (m) => (m.decision.evidence = ['nope']), /^decision\.evidence\[0\]: unresolved/],
  ['node evidence resolves', (m) => (m.architecture.nodes[0].evidence = ['nope']), /^architecture\.nodes\[0\]\.evidence\[0\]: unresolved/],
  ['edge evidence resolves', (m) => (m.architecture.edges[0].evidence = ['nope']), /^architecture\.edges\[0\]\.evidence\[0\]: unresolved/],
  ['flow evidence resolves', (m) => (m.flows[0].evidence = ['nope']), /^flows\[0\]\.evidence\[0\]: unresolved/],
  ['tradeoff evidence resolves', (m) => (m.tradeoffs[0].evidence = ['nope']), /^tradeoffs\[0\]\.evidence\[0\]: unresolved/],
  ['fit evidence resolves', (m) => (m.fit[0].evidence = ['nope']), /^fit\[0\]\.evidence\[0\]: unresolved/],
  ['question evidence resolves', (m) => (m.questions[0].evidence = ['nope']), /^questions\[0\]\.evidence\[0\]: unresolved/],
  ['api change evidence resolves', (m) => (m.api_changes[1].evidence = ['nope']), /^api_changes\[1\]\.evidence\[0\]: unresolved/],
  // ---- nodes, views, placement ----
  ['duplicate node ID', (m) => m.architecture.nodes.push({ ...m.architecture.nodes[0] }), /Duplicate node ID console/],
  ['duplicate view ID', (m) => (m.architecture.views[1].id = m.architecture.views[0].id), /Duplicate view ID/],
  ['place references unknown component', (m) => (m.architecture.views[0].places[0].node = 'ghost'), /place references unknown component ghost/],
  ['component placed twice in one view', (m) => m.architecture.views[0].places.push({ node: 'console', col: 2, row: 5 }), /component placed twice in the same view/],
  ['coincident nodes (test_coincident_nodes_rejected)', (m) => (m.architecture.views[0].places[1].col = 0), /components occupy the same grid cell/],
  [
    `a view shows at most ${MAX_PER_VIEW} components`,
    (m) => {
      for (let i = 0; i < 11; i++) {
        m.architecture.nodes.push({ id: `extra-${i}`, label: 'Extra', kind: 'module', status: 'unchanged', before: 'b', after: 'a', impact: 'i', evidence: ['D1'] });
        m.architecture.views[0].places.push({ node: `extra-${i}`, col: i % 3, row: 2 + Math.floor(i / 3) });
      }
    },
    new RegExp(`at most ${MAX_PER_VIEW} components`),
  ],
  ['focus must be placed in the view', (m) => (m.architecture.views[0].focus = 'rotation'), /focus must reference a component placed in that view/],
  [
    'unplaced component (test_unplaced_component_rejected)',
    (m) => {
      const orphan = m.architecture.views[1].places.pop().node;
      m.architecture.edges = m.architecture.edges.filter((e: Loose) => e.from !== orphan && e.to !== orphan);
    },
    /Component notify is not placed in any view/,
  ],
  // ---- edges ----
  ['duplicate edge ID', (m) => m.architecture.edges.push({ ...m.architecture.edges[0] }), /Duplicate edge ID/],
  ['edge endpoint missing', (m) => (m.architecture.edges[0].to = 'ghost'), /Edge endpoint missing \(ghost\)/],
  ['self-edges refused', (m) => (m.architecture.edges[1].to = m.architecture.edges[1].from), /Self-edges require a separate detail diagram/],
  ['modified edge requires before_label (test_modified_edge_requires_old_meaning)', (m) => delete m.architecture.edges[0].before_label, /before_label required/],
  ['absent endpoint (test_absent_endpoint_rejected)', (m) => (m.architecture.edges[3].status = 'unchanged'), /has an absent endpoint in before/],
  [
    'edge split across views (test_edge_split_across_views_rejected)',
    (m) => {
      const views = m.architecture.views;
      views[1].focus = 'keys';
      views[1].places = views[1].places.filter((p: Loose) => p.node !== 'secrets');
      const isolated = structuredClone(views[1]);
      isolated.id = 'isolated';
      delete isolated.focus;
      isolated.places = [{ node: 'secrets', col: 0, row: 0 }, { node: 'console', col: 1, row: 0 }];
      views.push(isolated);
    },
    /placed together in at least one view/,
  ],
  // ---- capabilities ----
  ['duplicate capability ID (test_duplicate_ids_rejected)', (m) => m.capabilities.push(structuredClone(m.capabilities[0])), /Duplicate capability ID org-access/],
  ['unknown capability component', (m) => (m.capabilities[0].components = ['ghost']), /Unknown capability component ghost/],
  ['capability needs one view showing all of it', (m) => (m.capabilities[0].components = ['console', 'secrets']), /no single view shows all/],
  // ---- flows ----
  ['duplicate flow ID', (m) => (m.flows[1].id = m.flows[0].id), /Duplicate flow ID/],
  ['duplicate step ID', (m) => (m.flows[0].after.steps[1].id = m.flows[0].after.steps[0].id), /Duplicate step ID/],
  ['step references absent component (removed node after)', (m) => (m.flows[0].after.steps[0].component = 'legacy'), /Step references absent component legacy/],
  ['step references unknown component', (m) => (m.flows[0].before.steps[0].component = 'ghost'), /Step references absent component ghost/],
  ['flow dangling link (test_flow_dangling_link_rejected)', (m) => (m.flows[0].after.links[0].to = 'not-a-step'), /Flow link endpoint missing/],
  // ---- model-wide ids (R4) ----
  ['ids are unique across the model', (m) => (m.questions[0].id = 'console'), /id console is already used by architecture\.nodes\[0\]\.id/],
  ['condition ids join the model-wide set', (m) => (m.decision.conditions[0].id = m.fit[0].id), /already used by decision\.conditions\[0\]\.id/],
  // ---- public API delta (R3) ----
  ['duplicate api change ID', (m) => m.api_changes.push(structuredClone(m.api_changes[1])), /Duplicate api change ID api-auth-header/],
  ['breaking requires migration', (m) => delete m.api_changes[0].migration, /^api_changes\[0\]\.migration: breaking change api-personal-tokens: migration required/],
  ['breaking requires impact', (m) => delete m.api_changes[0].impact, /^api_changes\[0\]\.impact: breaking change api-personal-tokens: impact required/],
  [
    'breaking requires observed evidence',
    (m) => {
      realReview(m as ReviewModel);
      m.evidence.forEach((e: Loose) => (e.kind = 'inferred'));
    },
    /api-personal-tokens: needs at least one observed evidence/,
  ],
  [
    'removed without breaking requires an explanation',
    (m) => {
      m.api_changes[0].breaking = false;
      delete m.api_changes[0].impact;
    },
    /removed surface api-personal-tokens is not marked breaking: explain why in impact/,
  ],
  ['undecided removal also needs an explanation', (m) => {
    m.api_changes[0].breaking = 'unknown';
    delete m.api_changes[0].impact;
  }, /removed surface api-personal-tokens is not marked breaking/],
  [
    'breaking change must be named in a condition',
    (m) => (m.decision.conditions[1].api_changes = ['api-auth-header']),
    /breaking change api-personal-tokens must be named in a decision\.conditions\[\]\.api_changes entry/,
  ],
  ['condition api_changes resolve', (m) => m.decision.conditions[0].api_changes = ['api-ghost'], /^decision\.conditions\[0\]\.api_changes\[0\]: unknown api change api-ghost/],
];

describe('validateReview', () => {
  it('accepts the demo model', () => {
    const result = validateReview(demo());
    expect(result.ok, result.ok ? '' : result.issues.map(formatIssue).join('\n')).toBe(true);
  });

  it.each(rows)('%s', (_name, mutate, expected) => {
    const model = demo() as unknown as Loose;
    mutate(model);
    const issues = issuesOf(model);
    expect(issues.some((i) => expected.test(i)), `issues:\n${issues.join('\n')}`).toBe(true);
  });

  it('reports every issue, not only the first', () => {
    const model = demo() as unknown as Loose;
    model.capabilities[0].evidence = ['missing'];
    model.architecture.views[0].places[1].col = 0;
    expect(issuesOf(model).length).toBeGreaterThanOrEqual(2);
  });

  it('a non-breaking, undecided or additive change needs no migration and no condition', () => {
    const model = demo();
    model.api_changes = model.api_changes.filter((a) => a.breaking !== true);
    model.decision.conditions.forEach((c) => delete c.api_changes);
    expect(issuesOf(model)).toEqual([]);
  });

  it('a real review passes with observed evidence behind a breaking change', () => {
    const model = demo();
    realReview(model);
    expect(issuesOf(model)).toEqual([]);
  });

  it('never throws, whatever it is given', () => {
    for (const input of [null, undefined, 42, 'x', [], { schema_version: 4 }]) {
      const result = validateReview(input);
      expect(result.ok).toBe(false);
    }
  });

  it('normalizes without mutating its input: places sorted, home_view computed', () => {
    const input = demo();
    input.architecture.views[0]!.places.reverse();
    const before = JSON.stringify(input);
    const result = validateReview(input);
    expect(JSON.stringify(input)).toBe(before);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    const places = result.model.architecture.views[0]!.places;
    expect(places.map((p) => [p.row, p.col])).toEqual([...places.map((p) => [p.row, p.col])].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    expect(result.model.capabilities.map((c) => c.home_view)).toEqual(['authorization', 'authorization', 'authorization', 'lifecycle']);
  });

  it('a stale home_view on input is recomputed', () => {
    const input = demo();
    input.capabilities[0]!.home_view = 'lifecycle';
    const result = validateReview(input);
    expect(result.ok && result.model.capabilities[0]?.home_view).toBe('authorization');
  });
});
