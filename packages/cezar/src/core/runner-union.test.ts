import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS, runnerSchema } from '@open-mercato/cezar-contract';
import { RUNNER_IDS as CORE_RUNNER_IDS } from './agent-runner.ts';
import { PROVIDER_IDS } from './provider-auth.ts';

/**
 * Phase 0 of spec 2026-09-19-runner-seam-native-backends: ONE runner tuple, every enumeration
 * derived from it. The #387 review lesson is that a hand-spelled key list silently strips every
 * runner added after the list was written; this guard fails the moment source code spells the
 * runner set out again instead of deriving it, so the next runner is a one-line change in
 * `packages/contract/src/health.ts` and typecheck (or this test) finds the rest.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SOURCE_ROOTS = ['packages/contract/src', 'packages/api-client/src', 'packages/cezar/src', 'packages/web/src'];

/**
 * Where the set may be written down: the one source, the two dependency-free `UiBackend` mirrors
 * (each pinned to the source by a type-level test: `ui-events.test.ts` here and in api-client),
 * and the two intentional SUBSETS — the runners with a host model catalog, and the runners that
 * read a shared `AGENTS.md` (`project.agents` in the config-file catalog).
 */
const ALLOWED_LITERAL_SITES = new Set([
  'packages/contract/src/health.ts',
  'packages/contract/src/workspace.ts', // modelDiscoveryRunnerSchema: the host-catalog subset
  'packages/api-client/src/protocol/ui-events.ts',
  'packages/cezar/src/core/ui-events.ts',
  'packages/cezar/src/agent-config/catalog.ts', // project.agents: the AGENTS.md readers subset
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__fixtures__' || entry === 'node_modules') continue;
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|e2e|smoke\.test|testkit)\.tsx?$/.test(entry)) {
      yield path;
    }
  }
}

/** Three or more runner ids spelled out in a row — a list, a tuple, or a union type. */
const RUNNER_LITERAL = `'(?:${runnerSchema.options.join('|')})'`;
const HAND_SPELLED_LIST = new RegExp(`${RUNNER_LITERAL}(?:\\s*[,|]\\s*${RUNNER_LITERAL}){2,}`, 'g');

describe('the runner set is written down once (spec Phase 0)', () => {
  it('the server-side tuples ARE the contract tuple, in its order', () => {
    expect(CORE_RUNNER_IDS).toBe(runnerSchema.options);
    expect(PROVIDER_IDS).toBe(CORE_RUNNER_IDS);
    expect([...RUNNER_IDS]).toEqual([...runnerSchema.options]);
  });

  it('no source file spells the runner set out by hand', () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (ALLOWED_LITERAL_SITES.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(HAND_SPELLED_LIST)) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
