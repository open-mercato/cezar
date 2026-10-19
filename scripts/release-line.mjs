#!/usr/bin/env node
// Release-line orchestrator — the side-effect half of packages/cezar/src/release/{stable,bump}.ts,
// driven by the release workflows (docs/publishing.md § Release lines):
//
//   cut       (Release cut, from main)   main at X.Y.Z → creates release/vX.Y.x at main's tip and
//                                        opens the PR that moves main to X.(Y+1).0.
//   prepare   (Release, from release/*)  picks the next version (patch bump once x.y.z is tagged),
//                                        stamps every manifest + lockfile + changelog and commits
//                                        the bump to the release branch BEFORE anything is built.
//   announce  (Release, after publish)   GitHub Release + tag at the bump commit, and a PR carrying
//                                        the changelog entry back to main.
//
// Every write to GitHub goes through scripts/lib/github.mjs. `--dry-run` computes and stamps the
// working tree but calls no API. Outputs go to $GITHUB_OUTPUT for the workflow's later steps.
//
// Env: GITHUB_REPOSITORY, GH_TOKEN, GITHUB_REF_NAME, and CEZ_RELEASE_ROOT like release.mjs.
// Tests pin `--latest <version|none>` (skips the registry lookup) and `--date <YYYY-MM-DD>`.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  nextMinorVersion,
  planRelease,
  releaseBranchFor,
  resolveStableDistTag,
  stampStableManifests,
} from '../packages/cezar/dist/release/stable.js';
import {
  changelogSection,
  dropUnreleased,
  ensureChangelogEntry,
  insertChangelogEntry,
  stampCompanionManifest,
  stampLockfile,
} from '../packages/cezar/dist/release/bump.js';
import { githubClient } from './lib/github.mjs';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    branch: { type: 'string' },
    'notes-file': { type: 'string' },
    version: { type: 'string' },
    sha: { type: 'string' },
    'dist-tag': { type: 'string' },
    latest: { type: 'string' },
    date: { type: 'string' },
  },
});
const command = positionals[0];
const dryRun = flags['dry-run'];

const repoRoot = process.env.CEZ_RELEASE_ROOT
  ? path.resolve(process.env.CEZ_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The release set (stamped by stampStableManifests, published by release.mjs) plus the cockpit,
// which versions in lockstep without shipping on its own.
const SET = {
  contract: 'packages/contract',
  apiClient: 'packages/api-client',
  cezar: 'packages/cezar',
  alias: 'alias-cezar',
  runAlias: 'alias-cezar-run',
};
const COMPANIONS = ['packages/web'];
const SKIP_NOTES_LABEL = 'skip-changelog';

const fail = (message) => {
  console.error(`release-line: ${message}`);
  process.exit(1);
};
const log = (message) => console.log(`release-line: ${message}`);
const emit = (result) => {
  console.log(`release-line result: ${JSON.stringify(result)}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(result).map(([k, v]) => `${k}=${v}`).join('\n')}\n`,
    );
  }
};

const abs = (rel) => path.join(repoRoot, rel);
const readText = (rel) => readFileSync(abs(rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const today = () => flags.date ?? new Date().toISOString().slice(0, 10);

/** Files rewritten in the working tree this run, keyed by repo-relative path. */
const changed = new Map();
const write = (rel, content) => {
  if (existsSync(abs(rel)) && readText(rel) === content) return;
  writeFileSync(abs(rel), content, 'utf8');
  changed.set(rel, content);
};

/** Stamp the release set, the cockpit and the lockfile to `version`. */
function stampEverything(version) {
  const set = Object.fromEntries(Object.entries(SET).map(([k, dir]) => [k, readJson(`${dir}/package.json`)]));
  const stamped = stampStableManifests(set, version);
  const names = Object.values(set).map((m) => m.name);
  const byDir = {};
  // Commit only the version and the re-pinned ranges: stamping also lends the aliases the
  // service's `repository` for npm provenance, which release.mjs re-adds at publish time.
  for (const [key, dir] of Object.entries(SET)) {
    const committed = { ...set[key], version: stamped[key].version };
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (set[key][section]) committed[section] = stamped[key][section];
    }
    byDir[dir] = committed;
  }
  for (const dir of COMPANIONS) {
    if (existsSync(abs(`${dir}/package.json`))) {
      byDir[dir] = stampCompanionManifest(readJson(`${dir}/package.json`), version, names);
    }
  }
  for (const [dir, manifest] of Object.entries(byDir)) write(`${dir}/package.json`, json(manifest));
  if (existsSync(abs('package-lock.json'))) {
    write('package-lock.json', json(stampLockfile(readJson('package-lock.json'), byDir)));
  }
  return stamped;
}

function github() {
  return githubClient({ token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY });
}

const files = () => [...changed].map(([p, content]) => ({ path: p, content }));

async function openPr(gh, { branch, parentSha, message, title, body }) {
  const sha = await gh.commitFiles({ parentSha, files: files(), message });
  await gh.setBranch(branch, sha);
  const pr = await gh.openPullRequest({ head: branch, base: 'main', title, body });
  // Release bookkeeping stays out of generated notes (.github/release.yml excludes the label).
  await gh.ensureLabel(SKIP_NOTES_LABEL, 'ededed', 'Left out of generated release notes');
  await gh.addLabels(pr.number, [SKIP_NOTES_LABEL]);
  log(`opened ${pr.html_url}`);
  return pr.html_url;
}

async function cut() {
  const branchName = process.env.GITHUB_REF_NAME ?? 'main';
  if (branchName !== 'main') fail(`a release line is cut from main, not ${branchName}`);
  const current = readJson(`${SET.cezar}/package.json`).version;
  const releaseBranch = releaseBranchFor(current);
  const next = nextMinorVersion(current);
  if (!releaseBranch || !next) fail(`main's version "${current}" is not a plain x.y.z`);
  const head = dryRun ? 'HEAD' : git('rev-parse', 'HEAD');
  stampEverything(next);
  // The line takes main's `# Unreleased` with it (it ships as the line's x.y.0).
  if (existsSync(abs('CHANGELOG.md'))) write('CHANGELOG.md', dropUnreleased(readText('CHANGELOG.md')));
  log(`main ${current} → ${releaseBranch} at ${head.slice(0, 12)}; main moves to ${next}`);

  let prUrl = '';
  if (dryRun) {
    log(`dry run — would create ${releaseBranch} and open the ${next} PR (${[...changed.keys()].join(', ')})`);
  } else {
    const gh = github();
    const existing = await gh.getBranchSha(releaseBranch);
    if (existing) log(`${releaseBranch} already exists at ${existing.slice(0, 12)} — left as it is`);
    else await gh.createBranch(releaseBranch, head);
    await gh.ensureLabel(`backport ${releaseBranch}`, 'c5def5', `Cherry-pick into ${releaseBranch} once merged`);
    await gh.ensureLabel('backport main', 'c5def5', 'Forward-port a release-line hotfix to main once merged');
    prUrl = await openPr(gh, {
      branch: `chore/open-v${next}`,
      parentSha: head,
      message: `chore(release): open ${next} on main\n\n${releaseBranch} now carries ${current} and its patches.`,
      title: `chore(release): open ${next} on main`,
      body: `\`${releaseBranch}\` was cut from \`${head.slice(0, 12)}\`. This moves main's release set to \`${next}\`, so features keep landing here while \`${releaseBranch}\` takes only fixes (label a PR \`backport ${releaseBranch}\`).`,
    });
  }
  emit({ releaseBranch, current, nextVersion: next, prUrl });
}

async function latestOnRegistry(name) {
  if (flags.latest !== undefined) return flags.latest === 'none' ? null : flags.latest;
  try {
    return execFileSync('npm', ['view', name, 'dist-tags.latest'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim() || null;
  } catch (error) {
    // Failing closed: guessing "nothing is latest" would let a backport move `latest` back.
    fail(`cannot read ${name}'s dist-tags from npm: ${error.message}`);
  }
}

async function prepare() {
  const branch = flags.branch ?? process.env.GITHUB_REF_NAME ?? '';
  const cezar = readJson(`${SET.cezar}/package.json`);
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
  const plan = planRelease({ branch, manifestVersion: cezar.version, tags });
  if (!plan.ok) fail(plan.error);
  const { version, bumped, previousTag } = plan;
  const distTag = resolveStableDistTag(version, await latestOnRegistry(cezar.name));
  log(`${branch}: releasing ${version}${bumped ? ` (patch bump from ${cezar.version})` : ''} under "${distTag}"`);

  if (bumped) stampEverything(version);
  const head = git('rev-parse', 'HEAD');
  let notes = flags['notes-file'] ? readFileSync(flags['notes-file'], 'utf8') : '';
  const changelog = existsSync(abs('CHANGELOG.md')) ? readText('CHANGELOG.md') : '';
  if (!notes && !dryRun && !changelogSection(changelog, version)) {
    notes = await github().generateNotes({ tag: `v${version}`, target: head, previousTag });
  }
  const entry = ensureChangelogEntry(changelog, version, today(), notes);
  write('CHANGELOG.md', entry.text);
  log(`changelog entry: ${entry.source}`);

  let sha = head;
  if (changed.size > 0 && !dryRun) {
    const gh = github();
    sha = await gh.commitFiles({
      parentSha: head,
      files: files(),
      message: `chore(release): ${version}`,
    });
    // Not forced: a branch that moved since checkout fails here instead of losing a commit.
    await gh.moveBranch(branch, sha, false);
    log(`committed the bump to ${branch} as ${sha.slice(0, 12)}`);
  }
  emit({ version, bumped, distTag, sha, previousTag: previousTag ?? '', changelog: entry.source });
}

async function announce() {
  const version = flags.version ?? fail('--version is required');
  const sha = flags.sha ?? fail('--sha is required');
  const distTag = flags['dist-tag'] ?? fail('--dist-tag is required');
  const cezar = readJson(`${SET.cezar}/package.json`);
  const runAlias = readJson(`${SET.runAlias}/package.json`).name;
  const section = changelogSection(readText('CHANGELOG.md'), version);
  if (!section) fail(`CHANGELOG.md has no entry for ${version}`);
  const install = distTag === 'latest' ? runAlias : `${runAlias}@${distTag}`;
  const body = [
    section.body,
    '',
    '### Install',
    '',
    '```bash',
    `npx ${runAlias}@${version}`,
    '```',
    '',
    `Published to npm as \`${cezar.name}\` and \`${runAlias}\` under \`${distTag}\` (\`npx ${install}\`).`,
  ].join('\n');

  if (dryRun) {
    log(`dry run — would release v${version} at ${sha.slice(0, 12)} (latest: ${distTag === 'latest'})`);
    console.log(body);
    emit({ released: false, changelogPr: '' });
    return;
  }
  const gh = github();
  const created = await gh.createRelease({ tag: `v${version}`, sha, name: `v${version}`, body, makeLatest: distTag === 'latest' });
  log(created ? `released v${version}` : `v${version} already has a GitHub Release — left as it is`);

  const mainSha = await gh.getBranchSha('main');
  const mainChangelog = await gh.readFile('CHANGELOG.md', mainSha);
  const carried = insertChangelogEntry(mainChangelog, version, `${section.heading}\n\n${section.body}\n`);
  let changelogPr = '';
  if (carried !== mainChangelog) {
    changed.clear();
    changed.set('CHANGELOG.md', carried);
    changelogPr = await openPr(gh, {
      branch: `chore/changelog-v${version}`,
      parentSha: mainSha,
      message: `docs(changelog): add the ${version} entry`,
      title: `docs(changelog): add the ${version} entry`,
      body: `Carries the \`${version}\` changelog entry released from \`${releaseBranchFor(version)}\` back to main.`,
    });
  }
  emit({ released: created, changelogPr });
}

const commands = { cut, prepare, announce };
if (!commands[command]) fail(`unknown command "${command ?? ''}" — expected cut, prepare or announce`);
await commands[command]();
