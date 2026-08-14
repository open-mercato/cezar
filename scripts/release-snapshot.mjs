#!/usr/bin/env node
// Snapshot publish orchestrator (`node scripts/release-snapshot.mjs`) — the
// side-effect half of src/release/snapshot.ts, invoked by the CI
// `publish-snapshot` job after `npm run build` (spec
// .ai/specs/2026-07-18-npm-preview-publish.md, #482).
//
// Also the engine behind the nightly channel (.github/workflows/nightly.yml):
// same stamping and same publish order, reached by setting CEZ_RELEASE_CHANNEL=nightly
// rather than by the event — see resolveChannel in src/release/snapshot.ts.
//
// Reads the CI facts from GitHub Actions' env, decides via computeSnapshot,
// stamps every manifest in the release set (intra-release dependencies pinned
// exact), publishes the non-`private` ones in DEPENDENCY ORDER — api-client,
// then the service, then the alias — always with an explicit --tag so a snapshot can never move
// `latest`, then emits a one-line JSON result to $GITHUB_OUTPUT for the
// PR-comment and summary steps.
//
// If the run is cancelled part-way through the publishes (ci.yml's workflow-level
// concurrency can still cancel a superseded PR run), the damage is benign: an
// earlier package's pr-tag runs briefly ahead of a later one's, the exact-version
// comment is never posted, and the next green run re-aligns every tag. Users
// install through the alias, which is published LAST, so its tag only ever moves
// once everything it depends on is already on the registry.
//
// Publishes with --ignore-scripts: the tarball-integrity gate (check:pack) has
// already run as the last leg of the `npm run build` this job just executed,
// and dist/ must exist for this script to even import. Re-running the build
// via prepublishOnly would only double the job time.
//
// Degrades loudly, never red: no publishable channel → exit 0 with
// attempted=false; NPM_TOKEN missing → forces --dry-run so the pipeline stays
// green (and visibly unconfigured) until the admin adds the secret.
//
// Flags: --dry-run (stamp + npm publish --dry-run, no registry writes).
// Env override for tests: CEZ_SNAPSHOT_ROOT (defaults to the repo root).

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublishable } from '../packages/cezar/dist/release/manifests.js';
import {
  buildInstallLines,
  computeSnapshot,
  stampManifests,
} from '../packages/cezar/dist/release/snapshot.js';

const repoRoot = process.env.CEZ_SNAPSHOT_ROOT
  ? path.resolve(process.env.CEZ_SNAPSHOT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The workspace root publishes nothing; every publishable manifest is named here explicitly.
const dirs = {
  contract: path.join(repoRoot, 'packages/contract'),
  apiClient: path.join(repoRoot, 'packages/api-client'),
  cezar: path.join(repoRoot, 'packages/cezar'),
  alias: path.join(repoRoot, 'alias-cezar'),
};

const readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const writeManifest = (dir, pkg) =>
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const emitOutput = (result) => {
  const line = JSON.stringify(result);
  console.log(`release-snapshot result: ${line}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `attempted=${result.attempted}\ndryRun=${result.dryRun ?? false}\nresult=${line}\n`,
      'utf8',
    );
  }
};

const manifests = {
  contract: readManifest(dirs.contract),
  apiClient: readManifest(dirs.apiClient),
  cezar: readManifest(dirs.cezar),
  alias: readManifest(dirs.alias),
};

const prNumberRaw = process.env.PR_NUMBER ?? '';
// The nightly channel is named after the UTC day it was cut. Overridable via env so
// the e2e suite can assert an exact version instead of the wall clock.
const nightlyDate = process.env.NIGHTLY_DATE || new Date().toISOString().slice(0, 10).replaceAll('-', '');
const plan = computeSnapshot({
  eventName: process.env.GITHUB_EVENT_NAME ?? '',
  refName: process.env.GITHUB_REF_NAME ?? '',
  requestedChannel: process.env.CEZ_RELEASE_CHANNEL || undefined,
  nightlyDate,
  prNumber: /^\d+$/.test(prNumberRaw) ? Number(prNumberRaw) : undefined,
  headRepo: process.env.PR_HEAD_REPO || undefined,
  repo: process.env.GITHUB_REPOSITORY || undefined,
  baseVersion: manifests.cezar.version,
  runNumber: Number(process.env.GITHUB_RUN_NUMBER ?? '0'),
  runAttempt: /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ? Number(process.env.GITHUB_RUN_ATTEMPT) : undefined,
});

if (!plan) {
  console.log('release-snapshot: no publishable channel for this event — nothing to do.');
  emitOutput({ attempted: false });
  process.exit(0);
}

let dryRun = process.argv.includes('--dry-run');
const token = process.env.NODE_AUTH_TOKEN ?? '';
if (!dryRun && !token) {
  console.log('release-snapshot: NPM_TOKEN is not configured — forcing --dry-run.');
  console.log('release-snapshot: see docs/publishing.md for the one-time admin setup.');
  dryRun = true;
}

const stamped = stampManifests(manifests, plan.version);
const order = ['contract', 'apiClient', 'cezar', 'alias'];
for (const key of order) writeManifest(dirs[key], stamped[key]);
console.log(
  `release-snapshot: stamped ${order.map((key) => stamped[key].name).join(' + ')} to ${plan.version} (dist-tag ${plan.distTag}${dryRun ? ', dry run' : ''})`,
);

// Provenance needs the job's OIDC token (permissions: id-token: write); only
// meaningful for a real publish from Actions.
const provenance = !dryRun && process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [];
// Same cross-platform npm resolution as scripts/check-pack.mjs: under `npm run`,
// npm_execpath is npm's own cli.js and runs through process.execPath everywhere.
const npmExecpath = process.env.npm_execpath;
const runNpm = (args, cwd) => {
  if (npmExecpath) {
    execFileSync(process.execPath, [npmExecpath, ...args], { cwd, stdio: 'inherit' });
  } else {
    const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npmCli, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  }
};
const publish = (dir, label) => {
  const args = [
    'publish',
    '--tag', plan.distTag,
    '--access', 'public',
    '--ignore-scripts',
    ...provenance,
    ...(dryRun ? ['--dry-run'] : []),
  ];
  console.log(`release-snapshot: npm ${args.join(' ')}  (${label})`);
  runNpm(args, dir);
};

// A `private` manifest is stamped above but never published — part of the release without
// being on the registry.
const published = [];
for (const key of order) {
  if (!isPublishable(stamped[key])) {
    console.log(`release-snapshot: ${stamped[key].name} is private — stamped, not published.`);
    continue;
  }
  publish(dirs[key], stamped[key].name);
  published.push(stamped[key].name);
}

emitOutput({
  attempted: true,
  dryRun,
  rootName: stamped.cezar.name,
  apiClientName: stamped.apiClient.name,
  aliasName: stamped.alias.name,
  version: plan.version,
  distTag: plan.distTag,
  publishedNames: published.join(','),
  installLines: buildInstallLines(stamped.alias.name, plan.version),
});
