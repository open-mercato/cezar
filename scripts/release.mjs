#!/usr/bin/env node
// Stable-release orchestrator (`node scripts/release.mjs <bump>`) — the
// side-effect half of src/release/stable.ts, invoked by the manually-triggered
// `Release` workflow (.github/workflows/release.yml) after `npm run build`
// (spec .ai/specs/2026-07-18-npm-preview-publish.md, #482).
//
// Unlike the snapshot pipeline, this is the ONLY thing that ever moves the
// `latest` dist-tag, and it never runs from a push — a human dispatches it and
// picks the bump (patch/minor/major, or `existing` to publish the version
// already committed). It stamps every manifest in the release set (intra-release
// dependencies kept as caret ranges so a stable cezar-cli follows compatible impl
// releases), then publishes them in DEPENDENCY ORDER — api-client, then the
// service, then the alias — always with `--tag latest`. Publishing a dependent
// before its dependency would briefly advertise a version that is not on the
// registry yet.
//
// A manifest marked `private` is stamped but NOT published: it is part of the
// release — its version moves in lockstep and the pins against it are rewritten
// — without being on the registry. That is how a package can be consumed inside
// the workspace long before it is offered to anyone else.
//
// Publishes with --ignore-scripts: the workflow ran `npm run build` (whose last
// leg, check:pack, is the tarball-integrity gate) immediately before this, and
// dist/ must exist for this script to even import. Stamping only rewrites the
// version field, so no rebuild is needed.
//
// Degrades loudly, never red: NPM_TOKEN missing → forces --dry-run so a
// misconfigured repo produces a visible dry run instead of a failed release.
// The workflow reads `version`/`published` from $GITHUB_OUTPUT to tag the
// commit and cut the GitHub Release only on a real publish.
//
// Usage: node scripts/release.mjs <patch|minor|major|existing> [--dry-run]
// Env override for tests: CEZ_RELEASE_ROOT (defaults to the repo root).

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublishable } from '../packages/cezar/dist/release/manifests.js';
import {
  computeStableVersion,
  isReleaseBump,
  stampStableManifests,
} from '../packages/cezar/dist/release/stable.js';

const repoRoot = process.env.CEZ_RELEASE_ROOT
  ? path.resolve(process.env.CEZ_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The workspace root publishes nothing; every publishable manifest is named here explicitly.
const dirs = {
  apiClient: path.join(repoRoot, 'packages/api-client'),
  cezar: path.join(repoRoot, 'packages/cezar'),
  alias: path.join(repoRoot, 'alias-cezar'),
};

const readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const writeManifest = (dir, pkg) =>
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const emitOutput = (result) => {
  console.log(`release result: ${JSON.stringify(result)}`);
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
  }
};

const bump = (process.argv[2] ?? process.env.RELEASE_BUMP ?? '').trim();
if (!isReleaseBump(bump)) {
  console.error(`release: unknown bump "${bump}" — expected patch, minor, major, or existing.`);
  process.exit(1);
}

const manifests = {
  apiClient: readManifest(dirs.apiClient),
  cezar: readManifest(dirs.cezar),
  alias: readManifest(dirs.alias),
};

// The service manifest is the base: it is the package whose version the release is named after.
const version = computeStableVersion(bump, manifests.cezar.version);
if (!version) {
  console.error(
    `release: cannot ${bump}-bump base version "${manifests.cezar.version}" — a stable release must start from a plain x.y.z.`,
  );
  process.exit(1);
}

let dryRun = process.argv.includes('--dry-run');
const token = process.env.NODE_AUTH_TOKEN ?? '';
if (!dryRun && !token) {
  console.log('release: NPM_TOKEN is not configured — forcing --dry-run.');
  console.log('release: see docs/publishing.md for the one-time admin setup.');
  dryRun = true;
}

const stamped = stampStableManifests(manifests, version);
for (const key of ['apiClient', 'cezar', 'alias']) writeManifest(dirs[key], stamped[key]);
const stampedNames = ['apiClient', 'cezar', 'alias'].map((key) => stamped[key].name);
console.log(
  `release: stamped ${stampedNames.join(' + ')} to ${version} (bump ${bump}, dist-tag latest${dryRun ? ', dry run' : ''})`,
);

// Provenance needs the job's OIDC token (permissions: id-token: write); only
// meaningful for a real publish from Actions.
const provenance = !dryRun && process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [];
// Same cross-platform npm resolution as scripts/release-snapshot.mjs.
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
    '--tag', 'latest',
    '--access', 'public',
    '--ignore-scripts',
    ...provenance,
    ...(dryRun ? ['--dry-run'] : []),
  ];
  console.log(`release: npm ${args.join(' ')}  (${label})`);
  runNpm(args, dir);
};

// Dependency order — see the header. `ReleaseManifests` declares its fields in this order for
// exactly this reason. A `private` manifest is stamped above but never published: it is part of
// the release (its version moves, its pins are rewritten) without being on the registry.
const published = [];
for (const key of ['apiClient', 'cezar', 'alias']) {
  if (!isPublishable(stamped[key])) {
    console.log(`release: ${stamped[key].name} is private — stamped to ${version}, not published.`);
    continue;
  }
  publish(dirs[key], stamped[key].name);
  published.push(stamped[key].name);
}

emitOutput({
  published: !dryRun,
  dryRun,
  bump,
  version,
  rootName: stamped.cezar.name,
  apiClientName: stamped.apiClient.name,
  aliasName: stamped.alias.name,
  publishedNames: published.join(','),
});
