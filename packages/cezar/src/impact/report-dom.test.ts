import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewModel } from './model.ts';
import { loadDemoReview, renderImpact } from './render.ts';
import { validateReview } from './validate.ts';

// The report draws itself in the browser, so these cases run its own script in a DOM: what a
// reader sees on the first screen, the Public API actions, and that nothing loads from outside.
const demo = () => structuredClone(loadDemoReview()) as ReviewModel;

// The service typechecks without the DOM lib (and @types/jsdom would add it), so the few DOM
// members these cases touch are typed here.
interface Node {
  textContent: string | null;
  tagName: string;
  hidden: boolean;
  children: ArrayLike<Node> & Iterable<Node>;
  classList: { contains(name: string): boolean };
  getAttribute(name: string): string | null;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): ArrayLike<Node> & Iterable<Node>;
  click(): void;
  dispatchEvent(event: unknown): boolean;
}
interface Window {
  document: Node;
  navigator: object;
  matchMedia: unknown;
  Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
}
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: object) => { window: Window };
  VirtualConsole: new () => { on(event: 'jsdomError', listener: (error: Error) => void): void };
};

function valid(model: ReviewModel): ReviewModel {
  const result = validateReview(model);
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return result.model;
}

function open(model: ReviewModel, previous?: ReviewModel) {
  const html = renderImpact(valid(model), previous ? { previous: { model: valid(previous), version: 1 } } : {});
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://report.test/',
    virtualConsole,
    beforeParse(window: Window) {
      window.matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
    },
  });
  const doc = dom.window.document;
  const $ = (selector: string) => doc.querySelector(selector);
  const all = (selector: string) => [...doc.querySelectorAll(selector)];
  const text = (el: Node | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { dom, doc, errors, $, all, text };
}

describe('impact report in a DOM', () => {
  it('draws every section without a script error', () => {
    const model = demo();
    const { errors, all, $ } = open(model);
    expect(errors).toEqual([]);
    expect(all('#facts .fact')).toHaveLength(3);
    expect(all('#conditions > li')).toHaveLength(model.decision.conditions.length);
    expect(all('#api .api-item')).toHaveLength(model.api_changes.length);
    expect(all('#caps .cap')).toHaveLength(model.capabilities.length);
    expect(all('#fit-list .fit-row')).toHaveLength(model.fit.length);
    expect(all('#question-list .question')).toHaveLength(model.questions.length);
    expect($('#h-conditions')?.textContent).toBe(`Before merging · ${model.decision.conditions.length} conditions`);
  });

  it.each([
    ['Approve', 'good', '✓'],
    ['Approve with comments', 'warn', '!'],
    ['Conditionally, into the core', 'warn', '!'],
    ['Request changes', 'bad', '✕'],
    ['Approve in direction, request changes before merge', 'bad', '✕'],
    ['Needs a human', 'neutral', '·'],
    ['Do not approve', 'bad', '✕'],
    ['Cannot approve yet', 'bad', '✕'],
    ['Not mergeable', 'bad', '✕'],
    ['Don’t merge', 'bad', '✕'],
    ['Changes requested', 'bad', '✕'],
    ['Needs changes', 'bad', '✕'],
    ['Reject', 'bad', '✕'],
    ['Blocked on the migration', 'bad', '✕'],
    ['Approve — no blockers', 'good', '✓'],
    ['Approve, non-blocking nits', 'good', '✓'],
    ['Approve the rejected alternative', 'good', '✓'],
  ])('reads the verdict tone of %j as %s, with a glyph', (label, tone, glyph) => {
    const model = demo();
    model.decision.label = label;
    const { $, text } = open(model);
    expect($('#facts')?.classList.contains(`t-${tone}`)).toBe(true);
    expect($('#overview')?.classList.contains(`t-${tone}`)).toBe(true);
    expect(text($('#facts .fact.dec .g'))).toBe(glyph);
    expect(text($('#facts .fact.dec .v'))).toBe(`${glyph}${label}`);
  });

  it('says what to do about each public API change', () => {
    const model = demo();
    const { $, all, text } = open(model);
    const card = (id: string) => $(`#api .api-item[data-ref="${id}"]`);
    const whens = (id: string) => all(`#api .api-item[data-ref="${id}"] .actions .when`).map((el) => el.textContent);

    // Breaking: the condition that settles it, then what consumers must do.
    expect(card('api-personal-tokens')?.classList.contains('brk')).toBe(true);
    expect(whens('api-personal-tokens')).toEqual(['Before merge', 'Consumers must']);
    const cond = card('api-personal-tokens')?.querySelector('[data-cond]');
    expect(cond?.getAttribute('data-cond')).toBe('cond-migration');
    expect(text(cond)).toBe('Condition 2 · Migration without cutting anyone off');
    expect(text(card('api-personal-tokens')?.querySelector('.who'))).toBe('Owner: Product owner');
    expect($('#conditions li[data-ref="cond-migration"]')).not.toBeNull();

    // Undecided: someone has to decide; not breaking and nothing to settle: no action.
    expect(card('api-key-store')?.classList.contains('unk')).toBe(true);
    expect(whens('api-key-store')).toEqual(['Before merge']);
    expect(text(card('api-key-store')?.querySelector('.actions'))).toContain('Decide whether this breaks');
    expect(whens('api-key-events')).toEqual(['No action']);
    // Breaking cards come first.
    expect(all('#api .api-item')[0]?.getAttribute('data-ref')).toBe('api-personal-tokens');
  });

  it('links a condition’s API tags to the API cards', () => {
    const { all } = open(demo());
    const chips = all('#conditions li[data-ref="cond-migration"] .chip');
    expect(chips.map((c) => [c.getAttribute('data-goto-kind'), c.getAttribute('data-goto'), c.classList.contains('brk')])).toEqual([
      ['api', 'api-personal-tokens', true],
      ['api', 'api-auth-header', false],
    ]);
  });

  it('copies a review comment for an API change', async () => {
    const { dom, $ } = open(demo());
    const writeText = vi.fn(async (_: string) => {});
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const button = $('#api .api-item[data-ref="api-personal-tokens"] [data-copy]')!;
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('Copied ✓'));
    const comment = writeText.mock.calls[0]?.[0] ?? '';
    expect(comment.split('\n')).toEqual([
      '`Authorization: Bearer <personal token> on /api/*` — breaking (removed)',
      'Impact: Integrations that still send an employee\'s personal token are refused once the compatibility path is gone.',
      'Before merge: condition 2 — Migration without cutting anyone off (Product owner)',
      'Consumers: Create an organization key in the console, replace the personal token in every integration, then confirm the audit log shows no personal-token calls.',
      'Evidence: D5, D2',
    ]);
  });

  it('fences a name that itself contains backticks', async () => {
    const model = demo();
    model.api_changes[0]!.name = '`id` → `key`';
    const { dom, $ } = open(model);
    const writeText = vi.fn(async (_: string) => {});
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    $(`#api .api-item[data-ref="${model.api_changes[0]!.id}"] [data-copy]`)!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]?.[0].split('\n')[0]).toMatch(/^`` `id` → `key` `` — /);
  });

  it('turns backticks into code and nothing else into markup', () => {
    const model = demo();
    model.decision.conditions[0]!.verification = 'Run `npm test`, then <img src=x onerror=alert(1)> and `<b>bold</b>`.';
    const { all } = open(model);
    const li = all('#conditions > li')[0]!;
    expect([...li.querySelectorAll('p code')].map((c) => c.textContent)).toEqual(['npm test', '<b>bold</b>']);
    expect(li.querySelector('img, b')).toBeNull();
  });

  it('shortens commit SHAs and keeps the full ones in the tooltip and the footer', () => {
    const model = demo();
    model.meta.base = 'c66225b1f5bd8e613a7fa019838f15b08c19a4df';
    model.meta.head = '8d30841488e156f7d38a18e5018377b0a442e455';
    const { $, text } = open(model);
    expect(text($('#eyebrow .sha'))).toBe('c66225b → 8d30841');
    expect($('#eyebrow .sha')?.getAttribute('title')).toBe(`${model.meta.base} → ${model.meta.head}`);
    expect(text($('#comparison'))).toBe(`${model.meta.base} → ${model.meta.head}`);
  });

  it('types evidence chips, previews them on hover and prints them all', () => {
    const model = demo();
    model.meta.demo = false;
    model.evidence.forEach((e) => (e.kind = e.id === 'D2' ? 'inferred' : e.id === 'D3' ? 'unknown' : 'observed'));
    const { dom, $, all, text } = open(model);
    const chip = $('#decision-evidence [data-evidence="D1"]')!;
    expect(chip.classList.contains('observed')).toBe(true);
    expect(chip.getAttribute('aria-label')).toBe(`Evidence D1: ${model.evidence[0]!.title}`);
    expect($('[data-evidence="D2"]')?.classList.contains('inferred')).toBe(true);
    chip.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
    const tip = $('.tip')!;
    expect(tip.hidden).toBe(false);
    expect(text(tip)).toContain(model.evidence[0]!.title);
    expect(text(tip)).toContain(model.evidence[0]!.source);
    expect(all('#evidence-print-body .ev')).toHaveLength(model.evidence.length);
  });

  it('tags a revised API change on its card head', () => {
    const next = demo();
    next.api_changes[0]!.migration = 'A different migration.';
    const { $ } = open(next, demo());
    expect($('#api .api-item[data-ref="api-personal-tokens"] > .api-head > .rev')).not.toBeNull();
    expect($('#what-changed [data-goto="api-personal-tokens"]')).not.toBeNull();
  });

  it('stays self-contained after it draws: no external or relative resource', () => {
    const { doc, all } = open(demo());
    expect(all('link, iframe, object, embed, img, video, audio, source')).toEqual([]);
    for (const el of all('[src], [srcset], [poster]')) throw new Error(`resource attribute on <${el.tagName}>`);
    for (const a of all('a[href]')) expect(a.getAttribute('href')).toMatch(/^(#|https:\/\/)/);
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).not.toMatch(/url\(|@import/);
  });

  it('keeps the first screen’s reading order (snapshot)', () => {
    const { all, text } = open(demo());
    const outline = [
      ...all('#facts .fact').map((f) => `fact: ${[...f.children].map(text).join(' | ')}`),
      ...all('#conditions > li').map((li) => `condition: ${text(li.querySelector('h3'))} · ${text(li.querySelector('.owner'))}`),
      ...all('#api .api-item').map((c) => `api: ${text(c.querySelector('.api-name'))} · ${text(c.querySelector('.pill'))} · ${all(`#api .api-item[data-ref="${c.getAttribute('data-ref')}"] .when`).map((w) => w.textContent).join(' / ')}`),
    ];
    expect(outline).toMatchSnapshot();
  });
});
