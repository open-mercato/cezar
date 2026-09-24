import assert from 'node:assert/strict';
import test from 'node:test';
import { SKILL_DIRS } from '../../src/skills.js';

/**
 * The cockpit's "no skills yet" hint tells users which directories to drop files into, from a
 * hand-copy of this list in the bundle (`SKILL_PROJECT_DIRS` in
 * web/app/src/components/skill-empty-hint.tsx) — it runs in another process and cannot import
 * the server. Before this test the copy could go stale in silence: add a discovery dir here and
 * the hint keeps naming the old three, with every suite green (#374).
 *
 * So this pins the server's ACTUAL discovery order. If it fails, discovery changed — update the
 * hint (and its own test) to match, then update the expectation below.
 */
test('the project skill dirs the hint promises are the ones discovery actually scans', () => {
  assert.deepEqual(
    SKILL_DIRS.map((d) => d.dir),
    [
      // Named individually by the hint (`SKILL_PROJECT_DIRS`, same order).
      '.ai/cezar/skills',
      '.ai/skills',
      '.agents/skills',
      // Per-agent mirrors of `.agents/skills` — the hint folds these into its
      // "agent mirrors like .claude/skills/ work too" aside instead of listing each.
      '.claude/skills',
      '.codex/skills',
      '.cursor/skills',
      '.opencode/skills',
    ],
  );
});
