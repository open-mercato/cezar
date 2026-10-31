#!/usr/bin/env node
// Release-line orchestrator — the side-effect half of packages/cezar/src/release/{stable,bump}.ts,
// driven by the release workflows (docs/publishing.md § Release lines):
//
//   cut       (Release cut, from main)       main at X.Y.Z → creates release/vX.Y.x at main's tip and
//                                            opens the PR that moves main to X.(Y+1).0.
//   prepare   (Release, from release/*)      picks the version (planRelease), stamps manifests +
//                                            lockfile + changelog and commits the bump to the line.
//   tag       (Release, after verify)        tags the bump commit; the tag starts Release publish.
//   verify    (Release publish, at the tag)  the tag names the manifests and sits on its line; skips
//                                            a version already released; resolves the dist-tag.
//   announce  (Release publish, last)        the changelog PR to main, then the GitHub Release —
//                                            the "done" marker, so it is created last.
//
// Every write to GitHub goes through scripts/lib/github.mts. `--dry-run` computes and stamps the
// working tree but calls no write API. Outputs go to $GITHUB_OUTPUT.
//
// Env: GITHUB_REPOSITORY, GH_TOKEN (the release App's token), GITHUB_REF_NAME, CEZ_RELEASE_ROOT.
// Tests pin `--registry <file.json>` ({ name: { latest, versions } }) and `--date <YYYY-MM-DD>`.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  highestLatest,
  nextMinorVersion,
  planRelease,
  releaseBranchFor,
  resolveStableDistTag,
  stampStableManifests,
} from '../packages/cezar/src/release/stable.ts';
import {
  changelogSection,
  dropUnreleased,
  ensureChangelogEntry,
  insertChangelogEntry,
  stampCompanionManifest,
  stampLockfile,
} from '../packages/cezar/src/release/bump.ts';
import type { ManifestLike, ReleaseManifests } from '../packages/cezar/src/release/manifests.ts';
import { githubClient, type GitHubClient } from './lib/github.mts';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    branch: { type: 'string' },
    'notes-file': { type: 'string' },
    version: { type: 'string' },
    sha: { type: 'string' },
    'dist-tag': { type: 'string' },
    tag: { type: 'string' },
    registry: { type: 'string' },
    date: { type: 'string' },
  },
});
const command = positionals[0];
const dryRun = flags['dry-run'];

const repoRoot = process.env.CEZ_RELEASE_ROOT
  ? path.resolve(process.env.CEZ_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The release set (stamped by stampStableManifests, published by release.mts) plus the cockpit,
// which versions in lockstep without shipping on its own.
type SetKey = keyof ReleaseManifests;
const SET: Record<SetKey, string> = {
  contract: 'packages/contract',
  apiClient: 'packages/api-client',
  cezar: 'packages/cezar',
  alias: 'alias-cezar',
  runAlias: 'alias-cezar-run',
};
const COMPANIONS = ['packages/web'];
const SKIP_NOTES_LABEL = 'skip-changelog';
// Bookkeeping PRs enter the review pipeline like any other, and stay out of release notes.
const BOOKKEEPING_LABELS = { bump: ['refactor', 'review', SKIP_NOTES_LABEL], changelog: ['documentation', 'review', SKIP_NOTES_LABEL] };

// A declaration, not an arrow: only a declared `never` function narrows the code after a call.
function fail(message: string): never {
  console.error(`release-line: ${message}`);
  process.exit(1);
}
const log = (message: string) => console.log(`release-line: ${message}`);
const emit = (result: Record<string, string | boolean>) => {
  console.log(`release-line result: ${JSON.stringify(result)}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(result).map(([k, v]) => `${k}=${v}`).join('\n')}\n`,
    );
  }
};

const abs = (rel: string) => path.join(repoRoot, rel);
const readText = (rel: string) => readFileSync(abs(rel), 'utf8');
const readJson = <T = ManifestLike,>(rel: string): T => JSON.parse(readText(rel)) as T;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const today = () => flags.date ?? new Date().toISOString().slice(0, 10);

/** Files rewritten in the working tree this run, keyed by repo-relative path. */
const changed = new Map<string, string>();
const write = (rel: string, content: string) => {
  if (existsSync(abs(rel)) && readText(rel) === content) return;
  writeFileSync(abs(rel), content, 'utf8');
  changed.set(rel, content);
};

/** Stamp the release set, the cockpit and the lockfile to `version`. */
const SET_KEYS = Object.keys(SET) as SetKey[];
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

function stampEverything(version: string) {
  const set = Object.fromEntries(SET_KEYS.map((k) => [k, readJson(`${SET[k]}/package.json`)])) as unknown as ReleaseManifests;
  const stamped = stampStableManifests(set, version);
  const names = SET_KEYS.map((k) => set[k].name);
  const byDir: Record<string, ManifestLike> = {};
  // Commit only the version and the re-pinned ranges: stamping also lends the aliases the
  // service's `repository` for npm provenance, which release.mts re-adds at publish time.
  for (const key of SET_KEYS) {
    const committed: ManifestLike = { ...set[key], version: stamped[key].version };
    for (const section of DEP_SECTIONS) {
      if (set[key][section]) committed[section] = stamped[key][section] as Record<string, string>;
    }
    byDir[SET[key]] = committed;
  }
  for (const dir of COMPANIONS) {
    if (existsSync(abs(`${dir}/package.json`))) {
      byDir[dir] = stampCompanionManifest(readJson(`${dir}/package.json`), version, names);
    }
  }
  for (const [dir, manifest] of Object.entries(byDir)) write(`${dir}/package.json`, json(manifest));
  if (existsSync(abs('package-lock.json'))) {
    write('package-lock.json', json(stampLockfile(readJson<Parameters<typeof stampLockfile>[0]>('package-lock.json'), byDir)));
  }
  return stamped;
}

function github() {
  return githubClient({ token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY });
}

const files = () => [...changed].map(([p, content]) => ({ path: p, content }));

async function openPr(
  gh: GitHubClient,
  { branch, parentSha, message, title, body, labels }: { branch: string; parentSha: string; message: string; title: string; body: string; labels: readonly string[] },
) {
  const sha = await gh.commitFiles({ parentSha, files: files(), message });
  await gh.setBranch(branch, sha);
  const pr = await gh.openPullRequest({ head: branch, base: 'main', title, body });
  await gh.ensureLabel(SKIP_NOTES_LABEL, 'ededed', 'Left out of generated release notes');
  await gh.addLabels(pr.number, labels);
  log(`opened ${pr.html_url}`);
  return pr.html_url;
}

async function cut() {
  const branchName = process.env.GITHUB_REF_NAME ?? 'main';
  if (branchName !== 'main') fail(`a release line is cut from main, not ${branchName}`);
  const current = readJson(`${SET.cezar}/package.json`).version;
  const releaseBranch = releaseBranchFor(current) ?? fail(`main's version "${current}" is not a plain x.y.z`);
  const next = nextMinorVersion(current) ?? fail(`main's version "${current}" is not a plain x.y.z`);
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
    // A re-run is only safe from the commit the line was cut at: rebuilt from a newer main,
    // the bump PR would drop an `# Unreleased` the line never received.
    if (existing && existing !== head) {
      fail(`${releaseBranch} was already cut at ${existing.slice(0, 12)} and main has moved to ${head.slice(0, 12)} — finish the open bump PR by hand`);
    }
    if (existing) log(`${releaseBranch} already exists at ${head.slice(0, 12)} — re-running the rest of the cut`);
    else await gh.createBranch(releaseBranch, head);
    await gh.ensureLabel(`backport ${releaseBranch}`, 'c5def5', `Cherry-pick into ${releaseBranch} once merged`);
    await gh.ensureLabel('backport main', 'c5def5', 'Forward-port a release-line hotfix to main once merged');
    prUrl = await openPr(gh, {
      branch: `chore/open-v${next}`,
      parentSha: head,
      message: `chore(release): open ${next} on main\n\n${releaseBranch} now carries ${current} and its patches.`,
      title: `chore(release): open ${next} on main`,
      body: `\`${releaseBranch}\` was cut from \`${head.slice(0, 12)}\`. This moves main's release set to \`${next}\`, so features keep landing here while \`${releaseBranch}\` takes only fixes (label a PR \`backport ${releaseBranch}\`).`,
      labels: BOOKKEEPING_LABELS.bump,
    });
  }
  emit({ releaseBranch, current, nextVersion: next, prUrl });
}

/** The release set's npm-published names (a `private` manifest is stamped, never published). */
function publishedNames() {
  return Object.values(SET)
    .map((dir) => readJson(`${dir}/package.json`))
    .filter((m) => m.private !== true)
    .map((m) => m.name);
}

/** `{ latest, versions }` for a package, `null` when npm has never heard of it. Fails closed on
 *  anything else: guessing would let a backport move `latest` backwards. */
interface RegistryInfo {
  latest: string | null;
  versions: string[];
}

function registryInfo(name: string): RegistryInfo | null {
  if (flags.registry) {
    const fixture = JSON.parse(readFileSync(flags.registry, 'utf8')) as Record<string, Partial<RegistryInfo>>;
    const entry = fixture[name];
    return entry ? { latest: entry.latest ?? null, versions: entry.versions ?? [] } : null;
  }
  try {
    const out = execFileSync('npm', ['view', name, 'dist-tags', 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const data = JSON.parse(out) as { 'dist-tags'?: { latest?: string }; versions?: string | string[] };
    return { latest: data['dist-tags']?.latest ?? null, versions: [data.versions ?? []].flat() };
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    if (/E404|404 Not Found/.test(`${stderr ?? ''}${message}`)) return null;
    return fail(`cannot read ${name} from npm: ${message}`);
  }
}

function resolveDistTag(version: string) {
  const latest = highestLatest(publishedNames().map((name) => registryInfo(name)?.latest));
  return resolveStableDistTag(version, latest);
}

async function prepare() {
  const branch = flags.branch ?? process.env.GITHUB_REF_NAME ?? '';
  const cezar = readJson(`${SET.cezar}/package.json`);
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
  const token = Boolean(process.env.GH_TOKEN);
  if (!token && !dryRun) fail('GH_TOKEN is not set');
  // A tokenless dry run cannot see GitHub Releases; it treats every tag as released.
  const releasedTags = token ? await github().releasedTags() : tags;
  const manifestPublished = publishedNames().some((name) => registryInfo(name)?.versions.includes(cezar.version));
  const plan = planRelease({ branch, manifestVersion: cezar.version, tags, releasedTags, manifestPublished });
  if (!plan.ok) fail(plan.error);
  const { version, bumped, resume, previousTag } = plan;

  if (resume) {
    const sha = git('rev-list', '-n', '1', `v${version}`);
    emit({ version, resume, sha });
    fail(`v${version} is tagged at ${sha.slice(0, 12)} but has no GitHub Release — finish it: re-run its "Release publish" run (or run Release publish from the v${version} tag). Fixes merged since ship in the next patch.`);
  }
  log(`${branch}: releasing ${version}${bumped ? ` (patch bump from ${cezar.version})` : ''} under "${resolveDistTag(version)}" (re-checked at publish)`);

  if (bumped) stampEverything(version);
  const head = git('rev-parse', 'HEAD');
  let notes = flags['notes-file'] ? readFileSync(flags['notes-file'], 'utf8') : '';
  const changelog = existsSync(abs('CHANGELOG.md')) ? readText('CHANGELOG.md') : '';
  if (!notes && token && !changelogSection(changelog, version)) {
    notes = await github().generateNotes({ tag: `v${version}`, target: head, previousTag });
  }
  const entry = ensureChangelogEntry(changelog, version, today(), notes);
  write('CHANGELOG.md', entry.text);
  log(`changelog entry: ${entry.source}`);

  let sha = head;
  if (changed.size > 0 && !dryRun) {
    const gh = github();
    sha = await gh.commitFiles({ parentSha: head, files: files(), message: `chore(release): ${version}` });
    // Not forced: a branch that moved since checkout fails here instead of losing a commit.
    await gh.moveBranch(branch, sha, false);
    log(`committed the bump to ${branch} as ${sha.slice(0, 12)}`);
  }
  emit({ version, bumped, resume, sha, previousTag: previousTag ?? '', changelog: entry.source });
}

async function tag() {
  const version = flags.version ?? fail('--version is required');
  const sha = flags.sha ?? fail('--sha is required');
  if (dryRun) {
    log(`dry run — would tag v${version} at ${sha.slice(0, 12)}`);
    return;
  }
  const created = await github().createTag(`v${version}`, sha);
  log(created ? `tagged v${version} at ${sha.slice(0, 12)} — Release publish takes it from here` : `v${version} already tags ${sha.slice(0, 12)}`);
}

async function verify() {
  const tagName = flags.tag ?? process.env.GITHUB_REF_NAME ?? '';
  if (!/^v\d+\.\d+\.\d+$/.test(tagName)) fail(`"${tagName}" is not a vX.Y.Z release tag`);
  const version = tagName.slice(1);
  const manifest = readJson(`${SET.cezar}/package.json`).version;
  if (manifest !== version) fail(`${tagName} names ${version} but the tagged manifests say ${manifest}`);
  const line = releaseBranchFor(version) ?? fail(`${tagName} is not a release version`);
  const sha = git('rev-parse', 'HEAD');
  if (git('remote').split('\n').includes('origin')) {
    git('fetch', '--no-tags', 'origin', `+refs/heads/${line}:refs/remotes/origin/${line}`);
  }
  try {
    git('merge-base', '--is-ancestor', sha, `refs/remotes/origin/${line}`);
  } catch {
    fail(`${tagName} (${sha.slice(0, 12)}) is not on ${line} — only the Release workflow tags releases`);
  }
  const released = await github().hasRelease(tagName);
  const distTag = resolveDistTag(version);
  log(released ? `${tagName} is already released — nothing to do` : `${tagName} at ${sha.slice(0, 12)} on ${line}: publishing under "${distTag}"`);
  emit({ version, distTag, released, sha, line });
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
    log(`dry run — would carry the entry to main, then release v${version} at ${sha.slice(0, 12)} (latest: ${distTag === 'latest'})`);
    console.log(body);
    emit({ released: false, changelogPr: '' });
    return;
  }
  const gh = github();
  // The changelog PR first: the GitHub Release marks the version done, and a re-run after a
  // failed carry-back must still find the version unfinished.
  const mainSha = (await gh.getBranchSha('main')) ?? fail('cannot read main — the changelog entry was not carried back');
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
      labels: BOOKKEEPING_LABELS.changelog,
    });
  }
  const created = await gh.createRelease({ tag: `v${version}`, sha, name: `v${version}`, body, makeLatest: distTag === 'latest' });
  log(created ? `released v${version}` : `v${version} already has a GitHub Release — left as it is`);
  emit({ released: created, changelogPr });
}

const commands: Record<string, () => Promise<void>> = { cut, prepare, tag, verify, announce };
const runCommand = commands[command ?? ''] ?? fail(`unknown command "${command ?? ''}" — expected cut, prepare, tag, verify or announce`);
await runCommand();
