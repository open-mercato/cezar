# Vendored cez-* Skills (Self-Contained Harness) Implementation Plan

> **Superseded in part on 2026-07-30.** The implementation-plan details below
> are historical. The current harness has an explicit development profile:
> `generic` (default) or `open-mercato`. Cezar always vendors
> `cez-harness` and `cez-setup-harness`, plus complete project-neutral generic
> judgment skills. It does not use short substitute prompts.
>
> Generic feature runs use `cez-spec-writing` → `cez-pre-implement-spec` →
> `cez-implement-spec` → `cez-code-review`; generic issue runs use
> `cez-verify-in-repo` → `cez-root-cause` → `cez-fix` → `cez-code-review`.
> The missing generic pre-implementation and implementation playbooks are
> Cezar-owned and preserved across regeneration; the other generic playbooks
> are generated from the mature shared skills.
>
> When the user explicitly selects Open Mercato, the workflow invokes complete
> canonical skills by their exact names:
>
> - feature: `om-spec-writing` → `om-pre-implement-spec` →
>   `om-implement-spec` → `om-code-review`;
> - issue: `om-verify-in-repo` → `om-root-cause` → `om-fix` →
>   `om-code-review`.
>
> Preflight materializes the selected directories (including references), pins
> their complete trees outside the model-writable worktree, and records their
> hashes plus the selected profile for recovery. The Cezar wrapper owns control
> flow, local claims, authoritative validation, review reconciliation, and
> staged-only delivery.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cezar's harness self-contained: the skills it needs ship inside the package under cezar-unique `cez-*` names (no dependence on `~/.claude/skills`, symlinks, or an unmerged upstream branch), materialize on disk in every run worktree, and the two config bugs that broke run `9788d87f` (stale `develop` base, setup-in-worktree) are fixed.

**Architecture:** A build-time vendor script copies 8 skills from a pinned `open-mercato/skills` commit into a committed `vendor/skills/` tree, applying a uniform token rename map (`om-harness` → `cez-harness`, …) across *every* vendored file so the runtime's internal self-references (sibling dir resolution in `harness.mjs`, contract-name checks, schema constants) stay consistent — upstream stays canonical; cezar's copies are generated artifacts, never hand-edited. Discovery gains a `bundled` source (lowest precedence). A new materializer copies any on-disk directory skill — bundled, global, agent-mirror — plus its `requires:` closure into `<cwd>/.claude/skills/`, replacing the team-only gate.

**Tech Stack:** Node 20 ESM, strict TS, zod, vitest + node:test. No new dependencies.

## Global Constraints

- **Never commit or push.** The working tree holds the previous session's staged harness work under review; each task ends with `git add <files>` only. (Deviation from the plan-skill's commit steps, deliberate.)
- Validation gate before finishing (AGENTS.md order): `npm run typecheck` → `npm test` → `npm run test:unit` → `npm run build` → `npm run test:package`.
- Zero config (AGENTS.md): no new env vars, no required state. Bundled skills are package content; `.claude/skills/` copies in worktrees are excluded via `.git/info/exclude` (existing mechanism).
- Rename map, longest-first, case-sensitive, each token compiled as `/<escaped>(?![a-z0-9-])/g`:
  `om-setup-agent-harness→cez-setup-harness`, `om-setup-agent-pipeline→cez-setup-pipeline`, `om-harness-review→cez-harness-review`, `om-verify-in-repo→cez-verify-in-repo`, `om-spec-writing→cez-spec-writing`, `om-code-review→cez-code-review`, `om-root-cause→cez-root-cause`, `om-harness→cez-harness`, `om-fix→cez-fix`.
  The lookahead keeps `om-fix-issue`, `om-harness-adapter-` tmp prefixes, and `.om-freeze-tests` sentinel untouched; uppercase `OM_HARNESS_*` / `OM_AGENT_HARNESS_CONFIG` env names are untouched by construction. `om-harness-review` precedes `om-harness` in the map so the output-style filename renames too.
- Vendored set (8): `om-harness`, `om-setup-agent-harness`, `om-setup-agent-pipeline`, `om-code-review`, `om-verify-in-repo`, `om-root-cause`, `om-fix`, `om-spec-writing`. Source: local checkout `<local open-mercato/skills checkout>` @ its current `feat/omdyo-harness` HEAD (record full SHA in the manifest).
- `requires:` injected by the vendor script: `cez-setup-harness → [cez-harness, cez-setup-pipeline]`; `cez-harness → [cez-code-review]` (harness.mjs resolves the review rubric as a sibling dir).

---

### Task 1: Vendor script + committed vendor/skills tree

**Files:**
- Create: `scripts/vendor-skills.mjs`
- Create (generated): `vendor/skills/MANIFEST.json`, `vendor/skills/cez-*/**`
- Test: `test/vendor-skills.test.ts` (vitest)
- Modify: `package.json` (`files` array gains `"vendor"`)

**Interfaces:**
- Produces: `vendor/skills/<name>/SKILL.md` dirs consumed by Task 2's discovery; `MANIFEST.json` shape `{ source: {repo, ref, commit}, generatedAt, nameMap, requires, skills[] }` consumed by Task 7's status endpoint.

- [ ] **Step 1: Write `scripts/vendor-skills.mjs`** — no deps, `node scripts/vendor-skills.mjs --source <checkout> [--ref <expected-sha>]`:

```js
#!/usr/bin/env node
// Vendors the harness skill set from an open-mercato/skills checkout into
// vendor/skills/ under cezar-unique cez-* names. The rename is a uniform
// token map applied to every text file so the runtime's self-references
// (sibling dir resolution, contract names, schema constants) stay
// consistent. Never edit vendor/skills/ by hand — rerun this script.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'vendor', 'skills');
// Longest-first; each entry replaced with a (?![a-z0-9-]) lookahead so
// om-fix never eats om-fix-issue and om-harness never eats om-harness-adapter-.
const NAME_MAP = [
  ['om-setup-agent-harness', 'cez-setup-harness'],
  ['om-setup-agent-pipeline', 'cez-setup-pipeline'],
  ['om-harness-review', 'cez-harness-review'],
  ['om-verify-in-repo', 'cez-verify-in-repo'],
  ['om-spec-writing', 'cez-spec-writing'],
  ['om-code-review', 'cez-code-review'],
  ['om-root-cause', 'cez-root-cause'],
  ['om-harness', 'cez-harness'],
  ['om-fix', 'cez-fix'],
];
const REQUIRES = {
  'cez-setup-harness': ['cez-harness', 'cez-setup-pipeline'],
  'cez-harness': ['cez-code-review'],
};
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.sh', '.yaml', '.yml', '.txt']);

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const source = get('--source');
if (!source) { console.error('usage: vendor-skills.mjs --source <skills-checkout> [--ref <sha>]'); process.exit(2); }
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expected = get('--ref');
if (expected && !commit.startsWith(expected)) { console.error(`checkout is at ${commit}, expected ${expected}`); process.exit(1); }
const ref = execFileSync('git', ['-C', source, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

const rename = (text) => NAME_MAP.reduce(
  (out, [from, to]) => out.replace(new RegExp(`${from.replace(/[-]/g, '\\-')}(?![a-z0-9-])`, 'g'), to),
  text,
);
const injectRequires = (skillMd, names) => {
  // Frontmatter is `---\nname: …\ndescription: …\n---`; add requires before the close.
  const close = skillMd.indexOf('\n---', 4);
  if (close === -1) throw new Error('SKILL.md has no frontmatter to inject requires into');
  return `${skillMd.slice(0, close)}\nrequires: [${names.join(', ')}]${skillMd.slice(close)}`;
};

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const vendored = [];
for (const [from, to] of NAME_MAP) {
  const srcDir = join(source, 'skills', from);
  let stat; try { stat = statSync(srcDir); } catch { continue; } // map entries like om-harness-review are filenames, not dirs
  if (!stat.isDirectory()) continue;
  const destDir = join(DEST, to);
  cpSync(srcDir, destDir, { recursive: true });
  // Apply the token map (and dir-entry renames) to everything under destDir.
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const renamedName = rename(entry.name);
      const renamedPath = join(dir, renamedName);
      if (renamedName !== entry.name) cpSync(path, renamedPath, { recursive: true }), rmSync(path, { recursive: true });
      if (entry.isDirectory()) { walk(renamedPath); continue; }
      if (!TEXT_EXT.has(extname(renamedName).toLowerCase())) continue;
      let text = rename(readFileSync(renamedPath, 'utf8'));
      if (renamedName === 'SKILL.md' && REQUIRES[to]) text = injectRequires(text, REQUIRES[to]);
      writeFileSync(renamedPath, text, { mode: statSync(renamedPath).mode });
    }
  };
  walk(destDir);
  vendored.push(to);
}
writeFileSync(join(DEST, 'MANIFEST.json'), `${JSON.stringify({
  source: { repo: 'open-mercato/skills', ref, commit },
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/vendor-skills.mjs',
  nameMap: Object.fromEntries(NAME_MAP),
  requires: REQUIRES,
  skills: vendored,
}, null, 2)}\n`);
console.log(`vendored ${vendored.length} skills from ${ref}@${commit.slice(0, 7)} into vendor/skills/`);
```

- [ ] **Step 2: Run it** — `node scripts/vendor-skills.mjs --source <local open-mercato/skills checkout>`. Expected: `vendored 8 skills from feat/omdyo-harness@a018dc9 into vendor/skills/`.
- [ ] **Step 3: Spot-verify the transform** (grep, all must hold):
  - `grep -rn "'../../cez-code-review/SKILL.md'" vendor/skills/cez-harness/scripts/harness.mjs` → 1 hit (sibling resolution renamed).
  - `grep -rn "om-harness\b" vendor/skills/*/SKILL.md` → 0 hits.
  - `grep -c "OM_HARNESS_" vendor/skills/cez-harness/scripts/harness.mjs` → unchanged count vs upstream (env names untouched).
  - `grep -n "requires:" vendor/skills/cez-setup-harness/SKILL.md vendor/skills/cez-harness/SKILL.md` → both present.
  - `grep -rn "om-fix-issue" vendor/skills/cez-harness/SKILL.md` → still present (lookahead preserved non-vendored names).
- [ ] **Step 4: Write the drift test** `test/vendor-skills.test.ts` (vitest) pinning those invariants:

```ts
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VENDOR = join(import.meta.dirname, '..', 'vendor', 'skills');
const manifest = JSON.parse(readFileSync(join(VENDOR, 'MANIFEST.json'), 'utf8'));

describe('vendored cez-* skills (generated by scripts/vendor-skills.mjs)', () => {
  test('manifest pins the upstream source commit and the full skill set', () => {
    expect(manifest.source.repo).toBe('open-mercato/skills');
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.skills).toEqual([
      'cez-setup-harness', 'cez-setup-pipeline', 'cez-verify-in-repo', 'cez-spec-writing',
      'cez-code-review', 'cez-root-cause', 'cez-harness', 'cez-fix',
    ]);
  });
  test('the harness runtime and its renamed self-references are on disk', () => {
    const runtime = join(VENDOR, 'cez-harness', 'scripts', 'harness.mjs');
    expect(existsSync(runtime)).toBe(true);
    const text = readFileSync(runtime, 'utf8');
    expect(text).toContain("'../../cez-code-review/SKILL.md'");
    expect(text).not.toMatch(/om-code-review/);
    expect(text).toContain('OM_HARNESS_MODEL'); // env contract untouched by the rename
  });
  test('every vendored skill declares its cez name and no stale om token', () => {
    for (const name of manifest.skills) {
      const skillMd = readFileSync(join(VENDOR, name, 'SKILL.md'), 'utf8');
      expect(skillMd).toContain(`name: ${name}`);
      for (const from of Object.keys(manifest.nameMap)) {
        expect(skillMd).not.toMatch(new RegExp(`${from}(?![a-z0-9-])`));
      }
    }
  });
  test('requires closure covers the setup skill and the runtime rubric', () => {
    expect(manifest.requires['cez-setup-harness']).toEqual(['cez-harness', 'cez-setup-pipeline']);
    expect(manifest.requires['cez-harness']).toEqual(['cez-code-review']);
  });
});
```

- [ ] **Step 5: Run it** — `npx vitest run test/vendor-skills.test.ts`. Expected: PASS (fix script/rerun until green).
- [ ] **Step 6: package.json** — `"files": ["dist", "web/open-mercato.svg", "web/dist", "scripts", "vendor", "README.md"]`.
- [ ] **Step 7: Stage** — `git add scripts/vendor-skills.mjs vendor test/vendor-skills.test.ts package.json`.

### Task 2: `bundled` discovery source

**Files:**
- Modify: `src/skills.ts` (source union, `bundledSkillsDir()`, scan in `discoverSkills`)
- Modify: `web/app/src/api/types.ts:640` (source union)
- Test: `src/skills.test.ts` (or the existing skills test file — follow the repo's current location for `discoverSkills` tests)

**Interfaces:**
- Produces: `Skill.source` gains `'bundled'`; `Skill.requires?: string[]` parsed from frontmatter; `discoverSkills(repoRoot, opts?: { bundledDir?: string | null })` — `null` disables bundled scanning (tests); default is the real vendor dir.
- Consumes: Task 1's `vendor/skills/` layout.

- [ ] **Step 1: Failing test** — in the discoverSkills test suite:

```ts
test('bundled skills are discovered last and lose name collisions to every other source', async () => {
  const bundled = await mkdtemp(join(tmpdir(), 'cez-bundled-'));
  await mkdir(join(bundled, 'cez-harness'), { recursive: true });
  await writeFile(join(bundled, 'cez-harness', 'SKILL.md'),
    '---\nname: cez-harness\ndescription: bundled runtime\nrequires: [cez-code-review]\n---\nbody');
  const repo = await mkdtemp(join(tmpdir(), 'cez-repo-'));
  const skills = await discoverSkills(repo, { bundledDir: bundled });
  const found = skills.find((s) => s.name === 'cez-harness');
  expect(found?.source).toBe('bundled');
  expect(found?.requires).toEqual(['cez-code-review']);
  // A repo-local skill of the same name wins:
  await mkdir(join(repo, '.ai', 'skills', 'cez-harness'), { recursive: true });
  await writeFile(join(repo, '.ai', 'skills', 'cez-harness', 'SKILL.md'), '---\nname: cez-harness\n---\nlocal');
  const again = await discoverSkills(repo, { bundledDir: bundled });
  expect(again.find((s) => s.name === 'cez-harness')?.source).toBe('ai');
});
```

- [ ] **Step 2: Run to verify failure** (type error: `bundledDir`/`requires` unknown).
- [ ] **Step 3: Implement in `src/skills.ts`:**
  - Union: `source: 'ai' | 'cezar' | 'agents' | 'global' | 'team' | 'bundled'`; add `requires?: string[]` to `Skill` (doc: "Sibling skills a host must materialize alongside this one — vendor/requires contract").
  - `export function bundledSkillsDir(): string` → `join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'skills')` (works from `src/` via tsx and from `dist/` in the tarball — both sit one level under the package root).
  - In `readMarkdownSkills`, parse `requires` from frontmatter: `const requires = Array.isArray(frontmatter.requires) ? frontmatter.requires.filter((r): r is string => typeof r === 'string' && r.length > 0) : undefined;` and include it in the pushed skill.
  - In `discoverSkills(repoRoot, opts: { bundledDir?: string | null } = {})`: `const bundledDir = opts.bundledDir === undefined ? bundledSkillsDir() : opts.bundledDir;` scan it with `readMarkdownSkills(bundledDir, 'bundled')` when non-null, and append its list **after** `teamSkills` in the merge loop (bundled = the floor).
- [ ] **Step 4: Run tests** — suite green; `web/app/src/api/types.ts` union += `'bundled'`; run `npm run typecheck` and chase any exhaustive-switch/label sites it flags (add a `bundled` label where source names render).
- [ ] **Step 5: Stage** — `git add src/skills.ts web/app/src/api/types.ts <test file>`.

### Task 3: Generic materializer with `requires` closure

**Files:**
- Create: `src/skills-materialize.ts`
- Test: `src/skills-materialize.test.ts`

**Interfaces:**
- Produces: `ensureSkillOnDisk(cwd: string, skill: Skill, catalog: readonly Skill[]): Promise<boolean>` — true when the skill (and its `requires` closure) is present under `<cwd>/.claude/skills/`; handles `team` via the existing bare-clone materializer, any other source via a real-directory copy; no-ops for single-file skills.
- Consumes: `materializeSkillDir` (skills-remote.ts), `Skill.requires` (Task 2).

- [ ] **Step 1: Failing tests** (`src/skills-materialize.test.ts`, vitest, tmp dirs):

```ts
test('copies a directory skill (through symlinks) into <cwd>/.claude/skills and excludes it from git', async () => {
  // real dir with SKILL.md + references/a.md + scripts/x.mjs; a symlink to it; a git-init'd cwd
  // expect: files copied under cwd/.claude/skills/<name>/, .git/info/exclude contains the entry
});
test('materializes the requires closure from the catalog (cycle-safe)', async () => {
  // catalog: cez-setup-harness requires [cez-harness]; cez-harness requires [cez-code-review];
  // cez-code-review requires [cez-setup-harness] (cycle). ensureSkillOnDisk on setup-harness
  // expect all three dirs present, no infinite loop, returns true
});
test('single-file skills and skills already inside cwd return true without copying', async () => { /* … */ });
test('a missing requires name degrades to false (caller surfaces the install hint)', async () => { /* … */ });
```

Write these as real tests with `mkdtemp`/`writeFile` fixtures (follow the pattern in `skills-remote` tests).
- [ ] **Step 2: Run to verify failure** (module not found).
- [ ] **Step 3: Implement `src/skills-materialize.ts`:**

```ts
import { cp, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Skill } from './skills.js';
import { materializeSkillDir } from './skills-remote.js';

/**
 * Put a skill's on-disk companion files (references/, scripts/, assets/,
 * hooks/) where the run can read them: `<cwd>/.claude/skills/<name>/`.
 * Bodies are always injected into the prompt; this is the other half of the
 * delivery contract for directory skills — previously team-repo-only, which
 * left bundled/global installs body-only (the run-9788d87f failure).
 * Also materializes the skill's `requires:` closure so contracts like
 * "resolve the cez-harness runtime beside this skill" hold by construction.
 */
export async function ensureSkillOnDisk(cwd: string, skill: Skill, catalog: readonly Skill[]): Promise<boolean> {
  const done = new Set<string>();
  const queue: Skill[] = [skill];
  let ok = true;
  while (queue.length) {
    const next = queue.shift()!;
    if (done.has(next.name)) continue;
    done.add(next.name);
    ok = (await materializeOne(cwd, next)) && ok;
    for (const dep of next.requires ?? []) {
      const found = catalog.find((s) => s.name === dep);
      if (!found) { ok = false; continue; }
      queue.push(found);
    }
  }
  return ok;
}

async function materializeOne(cwd: string, skill: Skill): Promise<boolean> {
  if (skill.source === 'team') {
    return skill.team?.dir ? materializeSkillDir(cwd, skill).catch(() => false) : true;
  }
  if (!skill.path.endsWith('SKILL.md')) return true; // single-file skill: body-only by design
  let srcDir: string;
  try { srcDir = await realpath(dirname(skill.path)); } catch { return false; }
  const target = join(cwd, '.claude', 'skills', skill.name);
  try {
    const cwdReal = await realpath(cwd);
    if (srcDir === resolve(target) || srcDir.startsWith(cwdReal + '/')) return true; // already inside the run tree
  } catch { /* cwd not resolvable — fall through to copy attempt */ }
  try {
    if (await stat(target).then((s) => s.isDirectory()).catch(() => false)) return true; // idempotent
    await cp(srcDir, target, { recursive: true, dereference: true });
    await excludeSkillFromGit(cwd, skill.name);
    return true;
  } catch { return false; }
}
```

`excludeSkillFromGit` — export the existing private `excludeFromGit(repoRoot, pattern)` from `skills-remote.ts` and call it with `.claude/skills/<name>/` (do not duplicate it).
- [ ] **Step 4: Run tests to green.**
- [ ] **Step 5: Stage** — `git add src/skills-materialize.ts src/skills-materialize.test.ts src/skills-remote.ts`.

### Task 4: Wire the materializer into both run paths

**Files:**
- Modify: `src/workflows/run.ts:1952-1961` (harness host `ensureSkill`) and `src/workflows/run.ts:2007-2020` (interactive skill step)
- Test: extend the run tests that cover team materialization (search for `materializ` in run tests) with a bundled-source case.

**Interfaces:**
- Consumes: `ensureSkillOnDisk` (Task 3).

- [ ] **Step 1: Failing test** — a run whose step skill has `source: 'bundled'` and a real tmp skill dir materializes it (and its `requires`) into the run cwd; assert the note event fires.
- [ ] **Step 2: Replace both call sites.** Host hook:

```ts
ensureSkill: async (name) => {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return false;
  // Directory skills carry companion files (references/, scripts/, hooks/)
  // the runtime needs on disk — materialize them (and their requires
  // closure) into the worktree, whatever source they came from.
  return ensureSkillOnDisk(state.cwd, skill, skills).catch(() => false);
},
```

Interactive step (replace the `skill.source === 'team' && skill.team?.dir` block):

```ts
const seeded = await ensureSkillOnDisk(state.cwd, skill, skills).catch(() => false);
if (seeded && skill.path.endsWith('SKILL.md')) {
  emit({ type: 'note', stepId: step.id, message: `skill "${skill.name}" materialized to .claude/skills/${skill.name}/` });
}
```

Drop the now-unused `materializeSkillDir` import from run.ts (it lives behind `ensureSkillOnDisk`).
- [ ] **Step 3: Tests green** (including the existing team-skill materialization tests — behavior preserved through the new seam).
- [ ] **Step 4: Stage** — `git add src/workflows/run.ts <test files>`.

### Task 5: cez-* rename across cezar source (staged harness code + UI)

**Files:** every non-vendor hit from `grep -rn "om-harness\|om-setup-agent-harness\|om-code-review\|om-verify-in-repo\|om-root-cause\|om-spec-writing\|'om-fix'\|om-setup-agent-pipeline" src/ web/app/src/ test/` — at minimum:
- Modify: `src/harness/driver.ts` (needed lists :402-403 → `['cez-harness', 'cez-spec-writing', 'cez-code-review']` / `['cez-harness', 'cez-verify-in-repo', 'cez-root-cause', 'cez-fix', 'cez-code-review']`; every phase `skill:` name and prompt mentioning a skill (:494-:783); preflight error :408 → `required skill "<name>" is missing from the bundled collection — reinstall cezar or run scripts/vendor-skills.mjs`; :413 → `cez-harness runtime not found in the worktree (.claude/skills/cez-harness/scripts/harness.mjs)`; docstrings)
- Modify: `src/harness/runtime.ts:38` (path segment `om-harness` → `cez-harness`; docstrings), `src/harness/types.ts` docstrings, `src/core/ui-events.ts:389` comment, `src/runs/store.ts:178` comment, `src/server/server.ts:2531,2544` comments, `src/workflows/run.ts:171,1728` comments
- Modify: `web/app/src/routes/new-task.tsx:281` → `source: { source: 'skill', ref: 'cez-setup-harness' }`
- Modify: staged tests referencing the old names (`src/harness/driver.test.ts`, `src/server/harness-api.test.ts`, `src/harness/runtime.test.ts`, `src/workflows/recover-harness.test.ts`, web tests) — same mechanical map.

**Interfaces:**
- Produces: the runtime path constant `.claude/skills/cez-harness/scripts/harness.mjs` that Task 7's status check reuses.

- [ ] **Step 1: Apply the map** (same 9-entry map, same lookahead rule) to the files above — by hand or a one-off sed sweep; **never** touch `vendor/`.
- [ ] **Step 2: Verify no stragglers** — `grep -rn "om-harness\|om-setup-agent\|om-code-review\|om-verify-in-repo\|om-root-cause\|om-spec-writing\|om-fix\b" src/ web/app/src/ test/ | grep -v vendor` → only prose references to the wider non-vendored OM collection (e.g. planner examples like `/om-auto-review-pr`) remain; zero hits in harness/driver/runtime/UI code paths.
- [ ] **Step 3: `npm run typecheck && npm test`** — green.
- [ ] **Step 4: Stage** the touched files.

### Task 6: Configure-harness runs in the repo root

**Files:**
- Modify: `web/app/src/routes/new-task.tsx` (`startHarnessSetup`)
- Test: the new-task test covering `startHarnessSetup` (extend the existing one in `new-task.test.tsx` / `new-task-harness.test.tsx`)

- [ ] **Step 1: Failing test** — invoking Configure sets `worktree: false` on the draft alongside the skill source.
- [ ] **Step 2: Implement** — in `startHarnessSetup`, add `worktree: false` to the `update({...})` payload with the comment: `// Setup stages .ai/agentic.config.json + hooks in the real repo for the human to review — a throwaway worktree would strand them on a cez/ branch (and a stale base once hid the config entirely: run 9788d87f).`
- [ ] **Step 3: Tests green; stage.**

### Task 7: `/harness/status` reports the bundled runtime

**Files:**
- Modify: `src/server/server.ts` (`/harness/status` handler), `web/app/src/api/types.ts` (status type)
- Test: `src/server/harness-api.test.ts`

**Interfaces:**
- Produces: response gains `runtime: { installed: boolean, source: Skill['source'] | null, commit: string | null }` (additive).

- [ ] **Step 1: Failing test** — status returns `runtime.installed: true` with `source: 'bundled'` and the manifest commit when the vendored tree exists; `installed: false, source: null, commit: null` when discovery finds no `cez-harness`.
- [ ] **Step 2: Implement** — resolve via `discoverSkills(repoRoot)`: find `cez-harness`; `installed` = found AND (`source !== 'bundled'` OR `existsSync(join(dirname(skill.path), 'scripts', 'harness.mjs'))`); `commit` from `vendor/skills/MANIFEST.json` (read-once, try/catch → null). Zod-free (response shaping only), follow the handler's existing style.
- [ ] **Step 3: Tests green; typecheck; stage.**

### Task 8: Base-branch fixes

**Files:**
- Modify: `.ai/cezar/config.json` → `{"baseBranch": "main"}`
- Modify: `src/git-worktree.ts` (add `remoteDefaultBranch`), `src/workflows/run.ts:1640-1650` (stale-base note)
- Test: `src/git-worktree.test.ts` + the run test around base resolution

- [ ] **Step 1: Failing test** — `remoteDefaultBranch(repoRoot)` returns `main` for a repo whose `origin/HEAD` → `origin/main`, `null` when unset; run emits a note when the configured base differs from the remote default.
- [ ] **Step 2: Implement** — in git-worktree.ts:

```ts
/** The branch `origin/HEAD` points at (`origin/main` → `main`), or null when
 *  the remote/symref is absent. Used only for a mismatch warning — resolution
 *  still honors the configured base. */
export async function remoteDefaultBranch(repoRoot: string): Promise<string | null> {
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (!head.ok) return null;
  const m = /^refs\/remotes\/origin\/(.+)$/.exec(head.stdout.trim());
  return m?.[1] ?? null;
}
```

In run.ts, after a configured base resolves (`base = resolved`), add:

```ts
const remoteDefault = await remoteDefaultBranch(this.repoRoot).catch(() => null);
if (remoteDefault && configured !== remoteDefault && configured !== `origin/${remoteDefault}`) {
  emit({
    type: 'note',
    message: `configured base branch "${configured}" is not the remote default "${remoteDefault}" — a stale base silently hides newer files from the run (config: .ai/cezar/config.json)`,
  });
}
```

- [ ] **Step 3: Tests green; stage** (`.ai/cezar/config.json` is gitignored data — just edit it, don't stage).

### Task 9: Docs, spec truth, and the full gate

**Files:**
- Modify: `AGENTS.md` (skills row: precedence chain gains `→ bundled (vendor/skills, cez-*)`; note the materializer covers every directory-skill source)
- Modify: `BACKWARD_COMPATIBILITY.md` (harness bullet: `GET /api/harness/status` gains additive `runtime`; new bullet: skills catalog gains `bundled` source + `requires` field, additive; note the cez-* naming decouples cezar's copies from globally installed `om-*` skills)
- Modify: `.ai/specs/2026-07-23-harness-orchestration.md` — Architecture §2 ("the skills materializer already copies directory skills" → describe `ensureSkillOnDisk` + bundled source), the "installed om-* skills" phrasing → "the vendored cez-* skills (generated from open-mercato/skills at a pinned commit — see `vendor/skills/MANIFEST.json`)", Q8 note that setup runs in-root, and the drift-risk paragraph → the vendor-script mitigation.
- Modify: `docs/mockups/README.md` only if it names `om-setup-agent-harness` (grep).

- [ ] **Step 1: Apply the doc edits above** (each is a handful of lines; keep the documents' voice).
- [ ] **Step 2: Full validation gate, in order:** `npm run typecheck` → `npm test` → `npm run test:unit` → `npm run build` → `npm run test:package`. All green — `check:pack`/`test:package` also prove `vendor/` ships in the tarball and `bundledSkillsDir()` resolves from `dist/`.
- [ ] **Step 3: Stage docs; final `git status` review** — everything staged, nothing committed.

## Self-Review

- **Spec coverage:** self-containment → Tasks 1-4; unique names → 1, 5; run-9788d87f blockers → 8 (config), 1-4 (runtime), 6 (setup placement); status truthfulness → 7; docs/compat → 9. Upstream PR #43 text fixes are intentionally out of scope (separate repo; the vendor transform makes cezar independent of them).
- **Type consistency:** `ensureSkillOnDisk(cwd, skill, catalog)` used identically in Tasks 3-4; `Skill.requires?: string[]` (2) parsed → consumed (3); `bundledDir?: string | null` option (2) used by tests; status `runtime` shape (7) matches the BC.md entry (9).
- **Placeholder scan:** Task 3 Step 1 sketches test *intents* with real fixture guidance — acceptable because the executor writes them against the concrete module in the same task; no other TBDs.
