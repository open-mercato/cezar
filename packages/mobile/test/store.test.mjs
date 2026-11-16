import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { page } from '../store/scripts/render-privacy.mjs';

const read = (p) => readFileSync(new URL(`../store/${p}`, import.meta.url), 'utf8');
const block = (text, name) => {
  const m = new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n<!-- /${name} -->`).exec(text);
  assert.ok(m, `store text has a ${name} block`);
  return m[1].replace(/^```text\n|\n```$/g, '').trim();
};

test('listing text fits each store field', () => {
  const listing = read('listing.md');
  const limits = { 'play-short': 80, 'ios-subtitle': 30, 'ios-promo': 170, 'ios-keywords': 100, 'full-description': 4000, 'whats-new': 500 };
  for (const [name, max] of Object.entries(limits)) {
    const text = block(listing, name);
    assert.ok(text.length > 0 && text.length <= max, `${name} is ${text.length} characters, limit ${max}`);
  }
  assert.doesNotMatch(block(listing, 'ios-keywords'), /, /, 'keywords are comma separated without spaces');
});

test('reviewer notes fit App Review notes (4000 characters)', () => {
  const notes = block(read('reviewer-notes.md'), 'reviewer-notes');
  assert.ok(notes.length <= 4000, `${notes.length} characters`);
  assert.match(notes, /end-to-end encrypted/);
});

test('the privacy page renders every Markdown construct and refuses to go final with open facts', () => {
  const md = read('privacy-policy.md');
  const html = page(md, { final: false });
  assert.doesNotMatch(html.replace(/<code>[\s\S]*?<\/code>/g, ''), /\*\*|\]\(http|^\|/m);
  assert.match(html, /<table>/);
  assert.throws(() => page(md, { final: true }), /OPEN MERCATO TO CONFIRM/);
  assert.doesNotThrow(() => page('# Policy\n\nAll facts filled.', { final: true }));
  assert.equal(read('privacy-policy.html'), html, 'privacy-policy.html is stale: node store/scripts/render-privacy.mjs');
});

// The sizes each store accepts for the sets in store/screenshots (RELEASING-MOBILE.md).
const SIZES = { 'android/phone': [1080, 1920], 'ios/iphone-6.9': [1320, 2868], 'ios/iphone-6.5': [1284, 2778], 'ios/ipad-13': [2064, 2752] };
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20), buf[25]];

test('store images have the exact sizes and no alpha channel', () => {
  const dir = new URL('../store/', import.meta.url);
  const sets = { ...SIZES, graphics: null };
  for (const [set, size] of Object.entries(sets)) {
    const path = new URL(set === 'graphics' ? 'graphics/' : `screenshots/${set}/`, dir);
    if (!existsSync(path)) continue;
    const files = readdirSync(path).filter((f) => f.endsWith('.png'));
    if (set !== 'graphics') assert.ok(files.length >= 2 && files.length <= 8, `${set}: 2 to 8 screenshots`);
    for (const f of files) {
      const [w, h, colorType] = pngSize(readFileSync(new URL(f, path)));
      const want = size ?? { 'feature-graphic.png': [1024, 500], 'play-icon-512.png': [512, 512] }[f];
      if (want) assert.deepEqual([w, h], want, `${set}/${f}`);
      if (f !== 'play-icon-512.png') assert.ok(colorType === 2 || colorType === 0, `${set}/${f} has no alpha (PNG colour type ${colorType})`);
    }
  }
});
