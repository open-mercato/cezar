#!/usr/bin/env node
// Vendors the harness skill set from an open-mercato/skills checkout into
// vendor/skills/ under cezar-unique cez-* names (spec
// .ai/specs/2026-07-24-vendored-cez-skills.md). The rename is a uniform
// token map applied to every text file so the runtime's self-references —
// sibling dir resolution in harness.mjs, contract-name checks, schema
// constants — stay consistent. Uppercase env names (OM_HARNESS_*,
// OM_AGENT_HARNESS_CONFIG) and non-vendored skill names (om-fix-issue,
// om-auto-*) are untouched by construction: the map is lowercase and each
// token is matched with a (?![a-z0-9-]) lookahead.
//
// Mirrored skills are generated — never edit those by hand; rerun this script:
//   node scripts/vendor-skills.mjs --source <skills-checkout> [--ref <sha>]
// The exception is CEZAR_OWNED (below): skills cezar authors itself, preserved
// verbatim across regeneration. Edit those directly.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'vendor', 'skills');
/** Staging area for CEZAR_OWNED dirs across the wipe/regenerate cycle. */
const HOLD = join(ROOT, 'vendor', '.skills-hold');
// Longest-first where one name prefixes another; the lookahead keeps
// om-fix from eating om-fix-issue and om-harness from eating the
// om-harness-adapter- tmp prefixes. om-harness-review (the output-style
// filename) precedes om-harness so it renames as a whole.
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
// Sibling skills a host must put on disk next to the named one: the runtime
// resolves the review rubric as a sibling directory (harness.mjs). The setup
// skill no longer requires pipeline setup — see CEZAR_OWNED below.
const REQUIRES = {
  'cez-setup-harness': ['cez-harness'],
  'cez-harness': ['cez-code-review'],
};

// Skills cezar AUTHORS rather than mirrors (2026-07-25). cezar and
// open-mercato/skills are separate implementations that share an approach, not
// code: where cezar's product shape diverges, cezar's copy is canonical and
// upstream has no say. `cez-setup-harness` is the first — the om version opens
// by routing the user through `om-setup-agent-pipeline` (tracker descriptor,
// labels, base branch) before they may bind a model, which is exactly right for
// the om PR pipeline and exactly wrong for cezar, where a Multi-model run needs
// none of it.
//
// These directories are preserved verbatim across regeneration: the script
// restores them after the wipe, and never copies over them from upstream.
const CEZAR_OWNED = new Set(['cez-setup-harness']);
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.sh', '.yaml', '.yml', '.txt']);

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const source = get('--source');
if (!source) {
  console.error('usage: vendor-skills.mjs --source <skills-checkout> [--ref <sha>]');
  process.exit(2);
}
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expected = get('--ref');
if (expected && !commit.startsWith(expected)) {
  console.error(`checkout is at ${commit}, expected ${expected}`);
  process.exit(1);
}
const ref = execFileSync('git', ['-C', source, 'rev-parse', '--abbrev-ref', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const rename = (text) =>
  NAME_MAP.reduce((out, [from, to]) => out.replace(new RegExp(`${from}(?![a-z0-9-])`, 'g'), to), text);

// Frontmatter is `---\nname: …\ndescription: …\n---`; add requires before the close.
const injectRequires = (skillMd, names) => {
  const close = skillMd.indexOf('\n---', 4);
  if (close === -1) throw new Error('SKILL.md has no frontmatter to inject requires into');
  return `${skillMd.slice(0, close)}\nrequires: [${names.join(', ')}]${skillMd.slice(close)}`;
};

// Lift the cezar-authored skills out of the way, wipe, then put them back —
// regeneration must never silently revert a deliberate divergence.
const preserved = new Map();
for (const name of CEZAR_OWNED) {
  const dir = join(DEST, name);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    continue; // not yet authored — nothing to preserve
  }
  if (!stat.isDirectory()) continue;
  cpSync(dir, join(HOLD, name), { recursive: true });
  preserved.set(name, join(HOLD, name));
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const vendored = [];
for (const [name, held] of preserved) {
  cpSync(held, join(DEST, name), { recursive: true });
  vendored.push(name);
}
rmSync(HOLD, { recursive: true, force: true });

for (const [from, to] of NAME_MAP) {
  if (CEZAR_OWNED.has(to)) continue; // cezar authors this one; upstream has no say
  const srcDir = join(source, 'skills', from);
  let stat;
  try {
    stat = statSync(srcDir);
  } catch {
    continue; // map entries like om-harness-review are filenames, not skill dirs
  }
  if (!stat.isDirectory()) continue;
  const destDir = join(DEST, to);
  cpSync(srcDir, destDir, { recursive: true });
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const renamedName = rename(entry.name);
      const renamedPath = join(dir, renamedName);
      if (renamedName !== entry.name) {
        cpSync(path, renamedPath, { recursive: true });
        rmSync(path, { recursive: true });
      }
      if (entry.isDirectory()) {
        walk(renamedPath);
        continue;
      }
      if (!TEXT_EXT.has(extname(renamedName).toLowerCase())) continue;
      let text = rename(readFileSync(renamedPath, 'utf8'));
      if (renamedName === 'SKILL.md' && REQUIRES[to]) text = injectRequires(text, REQUIRES[to]);
      writeFileSync(renamedPath, text, { mode: statSync(renamedPath).mode });
    }
  };
  walk(destDir);
  vendored.push(to);
}
writeFileSync(
  join(DEST, 'MANIFEST.json'),
  `${JSON.stringify(
    {
      source: { repo: 'open-mercato/skills', ref, commit },
      generatedAt: new Date().toISOString(),
      generatedBy: 'scripts/vendor-skills.mjs',
      nameMap: Object.fromEntries(NAME_MAP),
      requires: REQUIRES,
      /** Authored by cezar, not mirrored — `source.commit` says nothing about these. */
      cezarOwned: [...CEZAR_OWNED],
      skills: [...vendored].sort(),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `vendored ${vendored.length - preserved.size} skills from ${ref}@${commit.slice(0, 7)} into vendor/skills/` +
    (preserved.size ? ` (preserved cezar-authored: ${[...preserved.keys()].join(', ')})` : ''),
);
