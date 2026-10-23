#!/usr/bin/env node
// Stable-release orchestrator (`node scripts/release.mts <bump>`) — the
// side-effect half of src/release/stable.ts, invoked by the manually-triggered
// `Release` workflow (.github/workflows/release.yml) after `npm run build`
// (spec .ai/specs/2026-07-18-npm-preview-publish.md, #482).
//
// Unlike the snapshot pipeline, this is the ONLY thing that ever moves the
// `latest` dist-tag, and it never runs from a push. The Release workflow calls it
// with `existing` after scripts/release-line.mts has committed the version bump to
// the release branch; the other bumps remain for local use. It stamps every manifest in the release set (intra-release
// dependencies kept as caret ranges so a stable cezar-cli follows compatible impl
// releases), then publishes them in DEPENDENCY ORDER — api-client, then the
// service, then the aliases — under `--tag latest` unless told otherwise. Publishing a dependent
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
// `--dist-tag <tag>` overrides `latest`: the release-line workflow passes `latest-X.Y` for a
// backport to an older line (resolveStableDistTag), so it never moves `latest` backwards.
// A package whose version is already on the registry is skipped, so a re-run after a
// half-finished publish completes instead of failing on E403; `--reconcile-tag` then points the
// dist-tag at it, or a resumed `latest-X.Y` release would leave that package untagged. A failed
// publish is retried once: npm's provenance step reads a short-lived OIDC token, and that read
// fails transiently (IDENTITY_TOKEN_READ_ERROR half-published 0.16.2).
//
// Usage: node scripts/release.mts <patch|minor|major|existing> [--dry-run] [--dist-tag <tag>] [--reconcile-tag]
// Env override for tests: CEZ_RELEASE_ROOT (defaults to the repo root).

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublishable, type ManifestLike, type ReleaseManifests } from '../packages/cezar/src/release/manifests.ts';
import {
  computeStableVersion,
  isReleaseBump,
  stampStableManifests,
} from '../packages/cezar/src/release/stable.ts';

type SetKey = keyof ReleaseManifests;
const KEYS: readonly SetKey[] = ['contract', 'apiClient', 'cezar', 'alias', 'runAlias'];

const repoRoot = process.env.CEZ_RELEASE_ROOT
  ? path.resolve(process.env.CEZ_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The workspace root publishes nothing; every publishable manifest is named here explicitly.
const dirs: Record<SetKey, string> = {
  contract: path.join(repoRoot, 'packages/contract'),
  apiClient: path.join(repoRoot, 'packages/api-client'),
  cezar: path.join(repoRoot, 'packages/cezar'),
  alias: path.join(repoRoot, 'alias-cezar'),
  runAlias: path.join(repoRoot, 'alias-cezar-run'),
};

const readManifest = (dir: string): ManifestLike => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const writeManifest = (dir: string, pkg: ManifestLike) =>
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const emitOutput = (result: Record<string, string | boolean>) => {
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

const manifests: ReleaseManifests = {
  contract: readManifest(dirs.contract),
  apiClient: readManifest(dirs.apiClient),
  cezar: readManifest(dirs.cezar),
  alias: readManifest(dirs.alias),
  runAlias: readManifest(dirs.runAlias),
};

// The service manifest is the base: it is the package whose version the release is named after.
const version = computeStableVersion(bump, manifests.cezar.version);
if (!version) {
  console.error(
    `release: cannot ${bump}-bump base version "${manifests.cezar.version}" — a stable release must start from a plain x.y.z.`,
  );
  process.exit(1);
}

const distTagIndex = process.argv.indexOf('--dist-tag');
const distTag = distTagIndex > 0 ? (process.argv[distTagIndex + 1] ?? '').trim() : 'latest';
if (!/^[a-z][a-z0-9.-]*$/.test(distTag)) {
  console.error(`release: invalid --dist-tag "${distTag}".`);
  process.exit(1);
}

let dryRun = process.argv.includes('--dry-run');
const reconcileTag = process.argv.includes('--reconcile-tag');
const token = process.env.NODE_AUTH_TOKEN ?? '';
if (!dryRun && !token) {
  console.log('release: NPM_TOKEN is not configured — forcing --dry-run.');
  console.log('release: see docs/publishing.md for the one-time admin setup.');
  dryRun = true;
}

const stamped = stampStableManifests(manifests, version);
for (const key of KEYS) writeManifest(dirs[key], stamped[key]);
const stampedNames = KEYS.map((key) => stamped[key].name);
console.log(
  `release: stamped ${stampedNames.join(' + ')} to ${version} (bump ${bump}, dist-tag ${distTag}${dryRun ? ', dry run' : ''})`,
);

// Provenance needs the job's OIDC token (permissions: id-token: write); only
// meaningful for a real publish from Actions.
const provenance = !dryRun && process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [];
// Same cross-platform npm resolution as scripts/release-snapshot.mjs.
const npmExecpath = process.env.npm_execpath;
// stderr is captured (and always echoed) so a failed publish can be told apart by its code.
class NpmError extends Error {
  readonly stderr: string;
  constructor(args: string[], status: number | null, stderr: string) {
    super(`npm ${args[0]} exited with ${status}`);
    this.stderr = stderr;
  }
}
const runNpm = (args: string[], cwd: string) => {
  const [cmd, argv] = npmExecpath
    ? [process.execPath, [npmExecpath, ...args]]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', args];
  const result = spawnSync(cmd, argv, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'pipe'],
    shell: !npmExecpath && process.platform === 'win32',
  });
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new NpmError(args, result.status, result.stderr ?? '');
};
const publishedOverAlready = (error: unknown) =>
  error instanceof NpmError && /EPUBLISHCONFLICT|previously published|cannot publish over/i.test(error.stderr);
const alreadyPublished = (name: string) => {
  if (dryRun) return false;
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    return out.trim() === version;
  } catch {
    return false;
  }
};
const publish = (dir: string, label: string) => {
  const args = [
    'publish',
    '--tag', distTag,
    '--access', 'public',
    '--ignore-scripts',
    ...provenance,
    ...(dryRun ? ['--dry-run'] : []),
  ];
  console.log(`release: npm ${args.join(' ')}  (${label})`);
  try {
    runNpm(args, dir);
  } catch (error) {
    if (dryRun) throw error;
    console.log(`release: publishing ${label} failed (${(error as Error).message}) — retrying once in 15s.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
    if (alreadyPublished(label)) return;
    try {
      runNpm(args, dir);
    } catch (retryError) {
      // The first attempt went through after all; `npm view` simply had not caught up yet.
      if (!publishedOverAlready(retryError)) throw retryError;
      console.log(`release: ${label}@${version} was already published by the first attempt — done.`);
    }
  }
};

// Dependency order — see the header. `ReleaseManifests` declares its fields in this order for
// exactly this reason. A `private` manifest is stamped above but never published: it is part of
// the release (its version moves, its pins are rewritten) without being on the registry.
const published: string[] = [];
for (const key of KEYS) {
  if (!isPublishable(stamped[key])) {
    console.log(`release: ${stamped[key].name} is private — stamped to ${version}, not published.`);
    continue;
  }
  if (alreadyPublished(stamped[key].name)) {
    console.log(`release: ${stamped[key].name}@${version} is already on the registry — skipped.`);
    if (reconcileTag) {
      console.log(`release: npm dist-tag add ${stamped[key].name}@${version} ${distTag}`);
      runNpm(['dist-tag', 'add', `${stamped[key].name}@${version}`, distTag], dirs[key]);
    }
  } else {
    publish(dirs[key], stamped[key].name);
  }
  published.push(stamped[key].name);
}

emitOutput({
  published: !dryRun,
  dryRun,
  bump,
  version,
  distTag,
  rootName: stamped.cezar.name,
  apiClientName: stamped.apiClient.name,
  aliasName: stamped.alias.name,
  // The documented npx spelling — the release notes' install command uses it.
  runAliasName: stamped.runAlias.name,
  publishedNames: published.join(','),
});
