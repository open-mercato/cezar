#!/usr/bin/env node
// Unit check for the pure half of src/core/process-usage.ts (#348): ps-output
// parsing + process-tree aggregation against canned `ps -axo pid=,ppid=,rss=,%cpu=`
// output. Dependency-free; needs `npm run build` first (imports from dist/).
//   node scripts/test-process-usage.mjs

import assert from 'node:assert/strict';
import { aggregateTreeUsage, parsePsOutput } from '../dist/core/process-usage.js';

// Canned snapshot: two registered roots (100, 200) plus unrelated noise.
// Root 100 owns a 3-level tree: 100 → 110 → 111, and 100 → 120.
const PS_OUTPUT = `
    1     0  1200   0.1
  100     1 50000  10.0
  110   100 20000   5.5
  111   110  8000   0.0
  120   100  4000   2.5
  200     1 30000  50.0
  210   200 10000  25.0
  999     1 70000  99.0
garbage line that ps should never emit
  300   1
`;

const procs = parsePsOutput(PS_OUTPUT);
assert.equal(procs.length, 8, 'parses 8 well-formed rows, skips malformed ones');
assert.deepEqual(procs[1], { pid: 100, ppid: 1, rssKb: 50000, cpuPct: 10 });

// Root 100: 4 processes across 3 levels; rss in KB × 1024 → bytes.
const a = aggregateTreeUsage(procs, 100);
assert.deepEqual(a, {
  cpuPct: 18,
  rssBytes: (50000 + 20000 + 8000 + 4000) * 1024,
  procCount: 4,
});

// Root 200: 2 processes; the other tree's processes never leak in.
const b = aggregateTreeUsage(procs, 200);
assert.deepEqual(b, { cpuPct: 75, rssBytes: (30000 + 10000) * 1024, procCount: 2 });

// A root missing from the snapshot (process exited) → null, not zeros.
assert.equal(aggregateTreeUsage(procs, 12345), null);

// A leaf works as a root of its own single-node tree.
assert.deepEqual(aggregateTreeUsage(procs, 111), { cpuPct: 0, rssBytes: 8000 * 1024, procCount: 1 });

console.log('process-usage: all assertions passed');
