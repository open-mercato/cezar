/**
 * `validateReview` — the cross-reference rules of `pr-impact`'s `render_cockpit.py validate()`,
 * ported to run over the zod-shaped model (spec 2026-10-22-html-artifacts-and-impact, Q7), plus
 * the v4 rules for `api_changes` (R3) and model-wide ids (R4).
 *
 * Unlike the Python (fail on the first problem) it reports every issue it can find, each with a
 * path the agent can act on. It never throws. Cross-reference rules only run once the shape is
 * valid, because they would otherwise report the same hole twice.
 */
import { MAX_PER_VIEW, reviewModelSchema, type ReviewModel } from './model.ts';

export interface ReviewIssue {
  path: string;
  message: string;
}

export type ReviewValidation =
  | { ok: true; model: ReviewModel }
  | { ok: false; issues: ReviewIssue[] };

export function formatIssue(issue: ReviewIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function zodPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out ? `.${String(key)}` : String(key);
  }
  return out;
}

/** Credential-free https with a host; mirrors the Python's urlparse check. */
export function isSafeEvidenceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
}

export function validateReview(input: unknown): ReviewValidation {
  const parsed = reviewModelSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: zodPath(i.path), message: i.message })),
    };
  }
  // A deep copy: normalization (sorted places, home_view) must not mutate the caller's object.
  const model = structuredClone(parsed.data);
  const issues: ReviewIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });

  // ---- evidence -------------------------------------------------------------------------------
  const evidence = new Map<string, ReviewModel['evidence'][number]>();
  model.evidence.forEach((e, i) => {
    const at = `evidence[${i}]`;
    if (evidence.has(e.id)) issue(`${at}.id`, `Duplicate evidence ID ${e.id}`);
    if (!model.meta.demo && e.kind === 'demo') issue(`${at}.kind`, 'Demo evidence cannot appear in a real review');
    if (e.url !== undefined && !isSafeEvidenceUrl(e.url)) issue(`${at}.url`, 'Evidence URL must be credential-free HTTPS');
    if (!evidence.has(e.id)) evidence.set(e.id, e);
  });
  const refs = (ids: readonly string[], at: string) => {
    ids.forEach((ref, i) => {
      if (!evidence.has(ref)) issue(`${at}.evidence[${i}]`, `unresolved evidence ${ref}`);
    });
  };

  // ---- model-wide ids: the report addresses every askable element by id (R4) ------------------
  const owners = new Map<string, string>();
  const claim = (value: string, at: string) => {
    const first = owners.get(value);
    if (first) issue(at, `id ${value} is already used by ${first}; ids must be unique across the model`);
    else owners.set(value, at);
  };

  // ---- decision ---------------------------------------------------------------------------------
  refs(model.decision.evidence, 'decision');
  model.decision.conditions.forEach((c, i) => {
    claim(c.id, `decision.conditions[${i}].id`);
    refs(c.evidence, `decision.conditions[${i}]`);
  });

  // ---- architecture: nodes ----------------------------------------------------------------------
  const arch = model.architecture;
  const nodes = new Map<string, ReviewModel['architecture']['nodes'][number]>();
  arch.nodes.forEach((n, i) => {
    const at = `architecture.nodes[${i}]`;
    if (nodes.has(n.id)) issue(`${at}.id`, `Duplicate node ID ${n.id}`);
    else {
      nodes.set(n.id, n);
      claim(n.id, `${at}.id`);
    }
    refs(n.evidence, at);
  });

  // ---- views and placement ----------------------------------------------------------------------
  const viewIds = new Set<string>();
  const membership: Set<string>[] = [];
  arch.views.forEach((v, vi) => {
    const at = `architecture.views[${vi}]`;
    if (viewIds.has(v.id)) issue(`${at}.id`, `Duplicate view ID ${v.id}`);
    viewIds.add(v.id);
    const cells = new Set<string>();
    const members = new Set<string>();
    v.places.forEach((p, pi) => {
      const pat = `${at}.places[${pi}]`;
      if (!nodes.has(p.node)) issue(`${pat}.node`, `view ${v.id}: place references unknown component ${p.node}`);
      if (members.has(p.node)) issue(`${pat}.node`, `view ${v.id}: component placed twice in the same view`);
      members.add(p.node);
      const cell = `${p.row},${p.col}`;
      if (cells.has(cell)) issue(pat, `view ${v.id}: components occupy the same grid cell`);
      cells.add(cell);
    });
    if (members.size > MAX_PER_VIEW) {
      issue(`${at}.places`, `view ${v.id}: a view shows at most ${MAX_PER_VIEW} components; split it along a boundary instead`);
    }
    if (v.focus !== undefined && !members.has(v.focus)) {
      issue(`${at}.focus`, `view ${v.id}: focus must reference a component placed in that view`);
    }
    membership.push(members);
    v.places.sort((a, b) => a.row - b.row || a.col - b.col);
  });
  const placed = new Set(membership.flatMap((m) => [...m]));
  arch.nodes.forEach((n, i) => {
    if (!placed.has(n.id)) {
      issue(`architecture.nodes[${i}]`, `Component ${n.id} is not placed in any view and would never be drawn`);
    }
  });

  // ---- edges ------------------------------------------------------------------------------------
  const edgeIds = new Set<string>();
  arch.edges.forEach((e, i) => {
    const at = `architecture.edges[${i}]`;
    if (edgeIds.has(e.id)) issue(`${at}.id`, `Duplicate edge ID ${e.id}`);
    else {
      edgeIds.add(e.id);
      claim(e.id, `${at}.id`);
    }
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) issue(at, `Edge endpoint missing (${!from ? e.from : e.to})`);
    if (e.from === e.to) issue(at, 'Self-edges require a separate detail diagram');
    if (e.status === 'modified' && e.before_label === undefined) {
      issue(`${at}.before_label`, 'modified edge: before_label required (the relationship before the change)');
    }
    if (from && to) {
      // An edge cannot survive in a state where one of its endpoints does not exist.
      for (const [state, excluded] of [['before', 'added'], ['after', 'removed']] as const) {
        if (e.status !== excluded && (from.status === excluded || to.status === excluded)) {
          issue(at, `Edge ${e.id} has an absent endpoint in ${state}`);
        }
      }
      if (!membership.some((m) => m.has(e.from) && m.has(e.to))) {
        issue(at, `Edge ${e.id}: both endpoints must be placed together in at least one view, or the relationship is never drawn`);
      }
    }
    refs(e.evidence, at);
  });

  // ---- capabilities -----------------------------------------------------------------------------
  const capIds = new Set<string>();
  model.capabilities.forEach((c, i) => {
    const at = `capabilities[${i}]`;
    if (capIds.has(c.id)) issue(`${at}.id`, `Duplicate capability ID ${c.id}`);
    else {
      capIds.add(c.id);
      claim(c.id, `${at}.id`);
    }
    const unknown = c.components.filter((n) => !nodes.has(n));
    if (unknown.length) issue(`${at}.components`, `Unknown capability component ${unknown.join(', ')}`);
    const homeIndex = membership.findIndex((m) => c.components.every((n) => m.has(n)));
    const home = homeIndex >= 0 ? arch.views[homeIndex] : undefined;
    if (!home) {
      if (!unknown.length) {
        issue(`${at}.components`, `capability ${c.id}: no single view shows all of its components; place them together or add a view for it`);
      }
      delete c.home_view;
    } else c.home_view = home.id;
    refs(c.evidence, at);
  });

  // ---- flows ------------------------------------------------------------------------------------
  const flowIds = new Set<string>();
  model.flows.forEach((f, i) => {
    const at = `flows[${i}]`;
    if (flowIds.has(f.id)) issue(`${at}.id`, `Duplicate flow ID ${f.id}`);
    else {
      flowIds.add(f.id);
      claim(f.id, `${at}.id`);
    }
    refs(f.evidence, at);
    for (const [state, excluded] of [['before', 'added'], ['after', 'removed']] as const) {
      const diagram = f[state];
      const steps = new Set<string>();
      diagram.steps.forEach((s, si) => {
        const sat = `${at}.${state}.steps[${si}]`;
        if (steps.has(s.id)) issue(`${sat}.id`, `Duplicate step ID ${s.id}`);
        steps.add(s.id);
        const n = nodes.get(s.component);
        if (!n || n.status === excluded) issue(`${sat}.component`, `Step references absent component ${s.component}`);
      });
      diagram.links.forEach((l, li) => {
        if (!steps.has(l.from) || !steps.has(l.to)) {
          issue(`${at}.${state}.links[${li}]`, `Flow link endpoint missing (${!steps.has(l.from) ? l.from : l.to})`);
        }
      });
    }
  });

  // ---- judgment ---------------------------------------------------------------------------------
  const judged = [
    ['tradeoffs', model.tradeoffs],
    ['fit', model.fit],
    ['questions', model.questions],
  ] as const;
  for (const [name, list] of judged) {
    list.forEach((item, i) => {
      claim(item.id, `${name}[${i}].id`);
      refs(item.evidence, `${name}[${i}]`);
    });
  }

  // ---- public API delta (R3) --------------------------------------------------------------------
  const apiIds = new Set<string>();
  model.api_changes.forEach((a, i) => {
    const at = `api_changes[${i}]`;
    if (apiIds.has(a.id)) issue(`${at}.id`, `Duplicate api change ID ${a.id}`);
    else {
      apiIds.add(a.id);
      claim(a.id, `${at}.id`);
    }
    refs(a.evidence, at);
    if (a.breaking === true) {
      if (a.migration === undefined) issue(`${at}.migration`, `breaking change ${a.id}: migration required (what a consumer must do)`);
      if (a.impact === undefined) issue(`${at}.impact`, `breaking change ${a.id}: impact required (why it breaks)`);
      // Demo evidence stands in for "observed" only inside a demo, where nothing else is allowed.
      const proof = a.evidence.some((ref) => {
        const kind = evidence.get(ref)?.kind;
        return kind === 'observed' || (model.meta.demo && kind === 'demo');
      });
      if (!proof) issue(`${at}.evidence`, `breaking change ${a.id}: needs at least one observed evidence`);
    }
    if (a.status === 'removed' && a.breaking !== true && a.impact === undefined) {
      issue(`${at}.impact`, `removed surface ${a.id} is not marked breaking: explain why in impact`);
    }
  });
  const named = new Set<string>();
  model.decision.conditions.forEach((c, ci) => {
    (c.api_changes ?? []).forEach((ref, ri) => {
      if (!apiIds.has(ref)) issue(`decision.conditions[${ci}].api_changes[${ri}]`, `unknown api change ${ref}`);
      named.add(ref);
    });
  });
  model.api_changes.forEach((a, i) => {
    if (a.breaking === true && !named.has(a.id)) {
      issue(`api_changes[${i}]`, `breaking change ${a.id} must be named in a decision.conditions[].api_changes entry`);
    }
  });

  return issues.length ? { ok: false, issues } : { ok: true, model };
}
