import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReviewModel } from './model.ts';
import { scanHtml } from './html-scan.testkit.ts';
import { embedJson, loadDemoReview, loadTemplate, renderImpact, renderReview } from './render.ts';
import { validateReview } from './validate.ts';

// The escaping cases are test_cockpit.py's, ported 1:1 — they are why the renderer exists
// (spec 2026-10-22-html-artifacts-and-impact, Q7). The template carries three scripts: the
// pre-paint theme switch, the model payload, and the report itself.
const SCRIPTS = 3;
const DATA = 1;
const demo = () => structuredClone(loadDemoReview()) as ReviewModel;

function render(model: ReviewModel): string {
  const result = renderReview(model);
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return result.html;
}

describe('renderImpact', () => {
  it('the demo is valid and its payload round-trips (test_demo_valid_and_roundtrips)', () => {
    const model = demo();
    const page = scanHtml(render(model));
    const validated = validateReview(model);
    expect(validated.ok).toBe(true);
    expect(JSON.parse(page.scripts[DATA]!)).toEqual(validated.ok && validated.model);
    expect(page.scripts).toHaveLength(SCRIPTS);
  });

  it('script terminators cannot inject (test_script_terminators_cannot_inject)', () => {
    const payload = '</script><img src=x onerror=alert(1)><!-- "\u2028\u2029';
    const model = demo();
    model.meta.title = payload;
    model.evidence[0]!.detail = payload;
    const html = render(model);
    const page = scanHtml(html);
    expect(page.scripts).toHaveLength(SCRIPTS);
    expect(page.tags.some((t) => t.tag === 'img')).toBe(false);
    expect(JSON.parse(page.scripts[DATA]!).meta.title).toBe(payload);
    expect(page.scripts[DATA]).not.toMatch(/[\u2028\u2029]/);
  });

  it('view titles are data, not markup (test_view_titles_are_data_not_markup)', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const model = demo();
    model.architecture.views[1]!.title = payload;
    const page = scanHtml(render(model));
    expect(page.tags.some((t) => t.tag === 'img')).toBe(false);
    expect(JSON.parse(page.scripts[DATA]!).architecture.views[1].title).toBe(payload);
  });

  it('no external assets, no inline handlers, every anchor target exists (test_no_external_assets_and_all_anchor_targets_exist)', () => {
    const html = render(demo());
    const page = scanHtml(html);
    expect(page.ids.length).toBe(new Set(page.ids).size);
    for (const { attrs } of page.tags) {
      expect(Object.keys(attrs).some((k) => k.startsWith('on'))).toBe(false);
      const href = attrs.href ?? '';
      if (href.startsWith('#')) expect(page.ids).toContain(href.slice(1));
      expect(attrs.src).toBeUndefined();
    }
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/__[A-Z_]+__/);
    page.scripts.forEach((script, i) => {
      if (i !== DATA) expect(script).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/);
    });
  });

  it('the title is html-escaped and substituted once, with no $-pattern expansion', () => {
    const model = demo();
    model.meta.title = 'A & B __REVIEW_DATA__ $& $1 "q"';
    const html = render(model);
    expect(html).toContain('<title>Impact — A &amp; B __REVIEW_DATA__ $&amp; $1 &quot;q&quot;</title>');
    expect(scanHtml(html).scripts).toHaveLength(SCRIPTS);
  });

  it('embeds the model with <, >, &, U+2028 and U+2029 escaped', () => {
    expect(embedJson({ s: '<a>&\u2028\u2029' })).toBe('{"s":"\\u003ca\\u003e\\u0026\\u2028\\u2029"}');
  });

  it('stamps the model digest of the embedded payload', () => {
    const html = render(demo());
    const payload = scanHtml(html).scripts[DATA]!;
    const digest = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
    expect(html).toContain(`Model v4 · <span class="mono">${digest}</span>`);
  });

  it('renders every section of the report, the credit and the ask bridge', () => {
    const html = render(demo());
    const page = scanHtml(html);
    for (const id of ['overview', 'capabilities', 'architecture', 'public-api', 'flows', 'tradeoffs', 'fit', 'questions', 'nav', 'facts', 'conditions', 'views', 'api', 'evidence-dialog']) {
      expect(page.ids).toContain(id);
    }
    expect(html).toContain('Created by the Open Mercato Team');
    expect(page.tags.some((t) => t.tag === 'a' && t.attrs.href === 'https://github.com/open-mercato/open-mercato')).toBe(true);
    const main = page.scripts[2]!;
    expect(main).toContain('window.parent!==window');
    expect(main).toContain('type:"cezar.artifact.ref"');
    for (const kind of ['capability', 'node', 'edge', 'api', 'flow-step', 'flow', 'tradeoff', 'fit', 'question', 'condition']) {
      expect(main, kind).toMatch(new RegExp(`"${kind}"`));
    }
  });

  it('labels a PR as Before/After and a spec as Today/Proposed', () => {
    const pr = render(demo());
    expect(pr).toContain('data-subject="pr" data-before="Before" data-after="After"');
    expect(pr).toContain('for Before and After.');
    const model = demo();
    model.meta.subject_kind = 'spec';
    const spec = render(model);
    expect(spec).toContain('data-subject="spec" data-before="Today" data-after="Proposed"');
    expect(spec).toContain('for Today and Proposed.');
  });

  it('produces no HTML from an invalid model', () => {
    const model = demo() as unknown as { capabilities: unknown[] };
    model.capabilities = [];
    const result = renderReview(model);
    expect(result.ok).toBe(false);
    expect('html' in result).toBe(false);
  });

  it('renderImpact is deterministic', () => {
    const result = validateReview(demo());
    if (!result.ok) throw new Error('demo invalid');
    expect(renderImpact(result.model)).toBe(renderImpact(result.model));
  });
});

describe('renderImpact — what changed (R4)', () => {
  const valid = (model: ReviewModel) => {
    const result = validateReview(model);
    if (!result.ok) throw new Error('invalid');
    return result.model;
  };

  it('renders no strip without a previous version, and the strip with one', () => {
    const prev = valid(demo());
    expect(renderImpact(prev)).not.toContain('id="what-changed"');
    const next = demo();
    next.capabilities[0]!.title = 'Edited';
    next.api_changes.push({ ...next.api_changes[1]!, id: 'api-x', name: 'x()' });
    next.questions.splice(0, 1);
    const html = renderImpact(valid(next), { previous: { model: prev, version: 4 } });
    const page = scanHtml(html);
    expect(page.ids).toContain('what-changed');
    expect(html).toContain('What changed in v5');
    expect(html).toContain('compared with v4');
    const gotos = page.tags.filter((t) => t.attrs['data-goto'] !== undefined).map((t) => [t.attrs['data-change'], t.attrs['data-goto-kind'], t.attrs['data-goto']]);
    expect(gotos).toEqual([
      ['added', 'api', 'api-x'],
      ['changed', 'capability', next.capabilities[0]!.id],
    ]);
    // A removed element is listed, but there is nothing to jump to.
    expect(page.tags.filter((t) => t.attrs['data-change'] === 'removed')).toHaveLength(1);
    expect(page.tags.find((t) => t.attrs['data-change'] === 'removed')!.tag).toBe('span');
    expect(page.scripts).toHaveLength(SCRIPTS);
  });

  it('an unchanged model says so', () => {
    const model = valid(demo());
    expect(renderImpact(model, { previous: { model, version: 1 } })).toContain('No element of the model changed since v1.');
  });

  it('labels and ids in the strip are data, not markup', () => {
    const payload = '</script><img src=x onerror=alert(1)>"\'&$&__REVIEW_DATA__';
    const prev = valid(demo());
    const next = demo();
    next.capabilities[0]!.title = payload;
    next.tradeoffs.push({ ...next.tradeoffs[0]!, id: `t-${payload}`, title: payload });
    const html = renderImpact(valid(next), { previous: { model: prev, version: 1 } });
    const page = scanHtml(html);
    expect(page.scripts).toHaveLength(SCRIPTS);
    expect(page.tags.some((t) => t.tag === 'img')).toBe(false);
    expect(page.tags.some((t) => t.attrs['data-goto'] === `t-${payload}`)).toBe(true);
    const strip = html.slice(html.indexOf('id="what-changed"'), html.indexOf('</section>', html.indexOf('id="what-changed"')));
    expect(strip).not.toContain('<img');
    expect(strip).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;$&amp;__REVIEW_DATA__');
    expect(JSON.parse(page.scripts[DATA]!).capabilities[0].title).toBe(payload);
  });
});

// Implementation plan step 12: both themes, and no colour outside the token block.
describe('template.html', () => {
  const template = loadTemplate();
  const tokens = /\/\* tokens:start[\s\S]*?\/\* tokens:end \*\//.exec(template)?.[0] ?? '';

  it('keeps every colour inside the token block', () => {
    expect(tokens.length).toBeGreaterThan(0);
    const rest = template.replace(tokens, '');
    expect(rest).not.toMatch(/(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b(?![\w-])/i);
    expect(rest).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i);
  });

  it('defines dark by default, light by prefers-color-scheme, and both #theme= overrides', () => {
    expect(tokens).toMatch(/:root\{\s*color-scheme:dark;/);
    expect(tokens).toContain('@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){');
    expect(tokens).toContain(':root[data-theme="light"]{');
    expect(template).toMatch(/theme=\(dark\|light\)/);
  });

  it('keeps a strict meta CSP: no network source at all', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(template)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https?:/);
  });
});
