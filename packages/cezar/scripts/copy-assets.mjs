#!/usr/bin/env node
// Copy the non-TS runtime assets `tsc` does not emit into dist/, beside the module that reads
// them through `new URL(..., import.meta.url)` (spec 2026-10-22-html-artifacts-and-impact, Q7).
// `check:pack` (src/pack-check.ts) asserts they reach the tarball.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS = ['impact/template.html', 'impact/demo-review.json'];

for (const asset of ASSETS) {
  const to = join(pkg, 'dist', asset);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(pkg, 'src', asset), to);
}
console.log(`copy-assets: ${ASSETS.length} files → dist/`);
