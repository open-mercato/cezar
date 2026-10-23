/**
 * The impact renderer (spec 2026-10-22-html-artifacts-and-impact, Q7 / R1): a validated review
 * model into the self-contained `template.html` report. The template is a build asset copied
 * beside this module (`scripts/copy-assets.mjs`), so `src/` and `dist/` resolve it the same way.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { changeCount, diffReviewModels, type ModelChange, type ModelChangeKind, type ModelDiff } from './diff.ts';
import type { ReviewModel } from './model.ts';
import { validateReview, type ReviewIssue } from './validate.ts';

export const TEMPLATE_URL = new URL('./template.html', import.meta.url);
export const DEMO_REVIEW_URL = new URL('./demo-review.json', import.meta.url);

let cachedTemplate: string | undefined;
export function loadTemplate(): string {
  cachedTemplate ??= readFileSync(TEMPLATE_URL, 'utf8');
  return cachedTemplate;
}

export function loadDemoReview(): unknown {
  return JSON.parse(readFileSync(DEMO_REVIEW_URL, 'utf8'));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Script data must not terminate its script element or smuggle markup (render_cockpit.py). */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function modelDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
}

/** The version a revised report is compared with (spec R4, *What changed*). */
export interface PreviousReview {
  model: ReviewModel;
  version: number;
}

export interface RenderOptions {
  previous?: PreviousReview;
  template?: string;
}

const KIND_LABEL: Record<ModelChangeKind, string> = {
  summary: 'Summary',
  decision: 'Decision',
  condition: 'Condition',
  capability: 'Capability',
  node: 'Component',
  edge: 'Relationship',
  view: 'Map',
  flow: 'Flow',
  'flow-step': 'Flow step',
  api: 'Public API',
  tradeoff: 'Trade-off',
  fit: 'Fit',
  question: 'Question',
};
const CHANGE_GROUPS = [
  { key: 'added', title: 'Added', glyph: '+' },
  { key: 'changed', title: 'Changed', glyph: '~' },
  { key: 'removed', title: 'Removed', glyph: '−' },
] as const;
/** Per group; a rewrite of the whole model should not turn the strip into the report. */
export const MAX_CHANGES_LISTED = 40;

function changeItem(change: ModelChange, group: 'added' | 'changed' | 'removed', glyph: string): string {
  const text = `<span class="chg-g" aria-hidden="true">${glyph}</span><span class="chg-k">${escapeHtml(KIND_LABEL[change.kind])}</span> ${escapeHtml(change.label)}`;
  // Removed elements are not in this report, so there is nothing to jump to.
  if (group === 'removed') return `<li><span class="chg removed" data-change="removed">${text}</span></li>`;
  const attrs = `data-goto="${escapeHtml(change.id)}" data-goto-kind="${change.kind}" data-change="${group}"`;
  return `<li><button type="button" class="chg ${group}" ${attrs}>${text}</button></li>`;
}

/** The *What changed* strip under the hero; every model string goes through `escapeHtml`. */
export function renderWhatChanged(diff: ModelDiff, since: number): string {
  const total = changeCount(diff);
  const head = `<div class="sh"><span class="lb">Revision · compared with v${since}</span><h2 id="h-changes">What changed in v${since + 1}</h2></div>`;
  if (total === 0) return `<section class="changes" id="what-changed" aria-labelledby="h-changes">${head}<p class="chg-none">No element of the model changed since v${since}.</p></section>`;
  const groups = CHANGE_GROUPS.filter((g) => diff[g.key].length > 0).map((g) => {
    const list = diff[g.key];
    const more = list.length > MAX_CHANGES_LISTED ? `<li class="chg-more">and ${list.length - MAX_CHANGES_LISTED} more</li>` : '';
    return `<div class="chg-group"><span class="lb chg-${g.key}">${g.title} · ${list.length}</span><ul>${list
      .slice(0, MAX_CHANGES_LISTED)
      .map((c) => changeItem(c, g.key, g.glyph))
      .join('')}${more}</ul></div>`;
  });
  return `<section class="changes" id="what-changed" aria-labelledby="h-changes">${head}${groups.join('')}</section>`;
}

/**
 * Render an ALREADY VALIDATED model (`validateReview(...).model`). One regex pass with a
 * replacer function: sequential `String.replace` calls would let a title containing
 * `__REVIEW_DATA__` be substituted twice, and a string replacement would expand `$&`. With
 * `previous` (an equally validated model), the report carries the *What changed* strip.
 */
export function renderImpact(model: ReviewModel, options: RenderOptions = {}): string {
  const payload = embedJson(model);
  const spec = model.meta.subject_kind === 'spec';
  const previous = options.previous;
  const values: Record<string, string> = {
    REVIEW_TITLE: escapeHtml(model.meta.title),
    REVIEW_DATA: payload,
    MODEL_DIGEST: modelDigest(payload),
    SUBJECT_KIND: model.meta.subject_kind,
    BEFORE_LABEL: spec ? 'Today' : 'Before',
    AFTER_LABEL: spec ? 'Proposed' : 'After',
    WHAT_CHANGED: previous ? renderWhatChanged(diffReviewModels(previous.model, model), previous.version) : '',
  };
  return (options.template ?? loadTemplate()).replace(
    /__(REVIEW_TITLE|REVIEW_DATA|MODEL_DIGEST|SUBJECT_KIND|BEFORE_LABEL|AFTER_LABEL|WHAT_CHANGED)__/g,
    (_, key: string) => values[key] ?? '',
  );
}

export type ReviewRender =
  | { ok: true; html: string; model: ReviewModel }
  | { ok: false; issues: ReviewIssue[] };

/** Validate, then render. No HTML is ever produced from an invalid model. */
export function renderReview(input: unknown): ReviewRender {
  const result = validateReview(input);
  if (!result.ok) return result;
  return { ok: true, html: renderImpact(result.model), model: result.model };
}
