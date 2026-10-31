import { describe, expect, it } from 'vitest';
import { findPackGaps, firstPackReport } from './pack-check.ts';

// The decision behind `npm run check:pack` (scripts/check-pack.mjs): would the
// npm tarball ship a working cockpit? Pins the R1 "npm pack shipped no UI" bug.
describe('findPackGaps', () => {
  const goodPack = [
    'README.md',
    'dist/index.js',
    'scripts/mock-claude.mjs',
    'web/dist/icon.svg',
    'web/dist/index.html',
    'web/dist/assets/index-Ck3fQ2ab.js',
    'web/dist/assets/index-B9dL0xyz.css',
  ];

  it('accepts a tarball with the built shell and at least one asset', () => {
    expect(findPackGaps(goodPack)).toEqual([]);
  });

  it('rejects a tarball without web/dist/index.html', () => {
    const gaps = findPackGaps(goodPack.filter((f) => f !== 'web/dist/index.html'));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/index.html');
  });

  it('rejects a tarball whose shell has no hashed bundles', () => {
    const gaps = findPackGaps(['dist/index.js', 'web/dist/index.html']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/assets');
  });

  it('does not count a bare "web/dist/assets/" prefix as a bundle', () => {
    const gaps = findPackGaps(['web/dist/index.html', 'web/dist/assets/']);
    expect(gaps).toHaveLength(1);
  });

  it('reports both gaps for the pre-redesign file list (the R1 bug)', () => {
    // What `files` shipped before the packaging flip: sources, no Vite build.
    const legacy = ['README.md', 'dist/index.js', 'web/index.html', 'web/app.js', 'web/style.css'];
    expect(findPackGaps(legacy)).toHaveLength(2);
  });

  it('does not accept nested lookalikes for the shell (exact path match)', () => {
    const gaps = findPackGaps(['web/dist/nested/index.html', 'web/dist/assets/a.js']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/index.html');
  });
});

// npm <= 11 prints an array of reports; npm 12 prints an object keyed by package name.
describe('firstPackReport', () => {
  const report = { filename: 'open-mercato-cezar-1.0.0.tgz', files: [{ path: 'dist/index.js' }] };

  it('reads the array shape (npm <= 11)', () => {
    expect(firstPackReport([report])).toEqual(report);
  });

  it('reads the object-keyed-by-name shape (npm 12)', () => {
    expect(firstPackReport({ '@open-mercato/cezar': report })).toEqual(report);
  });

  it('returns undefined for empty or non-object output', () => {
    expect(firstPackReport([])).toBeUndefined();
    expect(firstPackReport({})).toBeUndefined();
    expect(firstPackReport(null)).toBeUndefined();
  });
});
