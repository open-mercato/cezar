/**
 * `cezar install | update | versions | use | link | unlink` — the terminal side of the managed
 * install. No server, no repo: only `~/.cezar` and the npm registry. The cockpit's dialog drives
 * the same service; this is what a headless box or a shell-only user gets.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { branchOf, cezarPackageRoot, discoverCheckouts } from './checkouts.ts';
import { activate, activeId, findInstalled, linkCheckout, listInstalled, listLinks, removeInstalled } from './layout.ts';
import { ensurePathHook, isOnPath, writeLaunchers } from './launcher.ts';
import { installFromRegistry } from './installer.ts';
import { distTagFor, RegistryCache } from './registry.ts';
import { compareVersions } from './semver.ts';
import type { SelfUpdateService } from './service.ts';
import { autoPruneVersions, configuredVersionRetention, DEFAULT_VERSION_RETENTION, listVersionBackups, pruneVersions, type PruneResult } from './versions-prune.ts';

export interface SelfUpdateCliOptions {
  service: SelfUpdateService;
  channel?: string;
  version?: string;
  modifyPath: boolean;
  /** `link --use`: activate the linked checkout right away. */
  use?: boolean;
}

export async function runSelfUpdateCommand(command: string, args: string[], opts: SelfUpdateCliOptions): Promise<number> {
  switch (command) {
    case 'install':
      return installCommand(opts);
    case 'update':
      return updateCommand(opts);
    case 'versions':
      return versionsCommand();
    case 'use':
      return useCommand(args[0]);
    case 'link':
      return linkCommand(args[0], opts.use === true);
    case 'unlink':
      return unlinkCommand(args[0]);
    default:
      return 1;
  }
}

async function installCommand(opts: SelfUpdateCliOptions): Promise<number> {
  const { service } = opts;
  console.log(`\n  cezar install — managed layout under ~/.cezar (this build: ${service.installKind})\n`);
  try {
    const result = await service.installSelf((line) => console.log(`  · ${line}`));
    const dir = writeLaunchers();
    console.log(`\n  ✓ installed ${result.id} and made it current`);
    console.log(`  ✓ launchers: ${dir}/cezar, ${dir}/cez`);
    if (isOnPath(dir)) {
      console.log(`  ✓ ${dir} is already on PATH — run: cezar\n`);
      return 0;
    }
    if (!opts.modifyPath) {
      console.log(`\n  add this to your shell profile, then run \`cezar\`:\n\n    export PATH="${dir}:$PATH"\n`);
      return 0;
    }
    const hook = ensurePathHook(dir);
    if (hook.file) {
      console.log(`  ${hook.alreadyPresent ? '✓' : '+'} PATH hook in ${hook.file}${hook.alreadyPresent ? ' (already there)' : ''}`);
      console.log(`\n  open a new terminal (or: source ${hook.file}) and run: cezar\n`);
    } else {
      console.log(`\n  add ${dir} to PATH, then run \`cezar\`:\n\n    ${hook.line}\n`);
    }
    return 0;
  } catch (error) {
    console.error(`\n  ✗ install failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function updateCommand(opts: SelfUpdateCliOptions): Promise<number> {
  const { service } = opts;
  const requested = opts.channel;
  if (requested !== undefined && requested !== 'stable' && requested !== 'nightly' && requested !== 'development') {
    console.error(`  --channel must be stable, nightly or development (got ${requested})`);
    return 1;
  }
  if (requested) await service.setChannel(requested);
  const channel = await service.channel();
  if (channel === 'development' && !opts.version) {
    // Development follows no dist-tag: there is no "newest" to update to.
    console.log('\n  channel development — nothing to update to. Pick a build by hand:');
    console.log('    cezar link [<worktree>] --use   run a cezar worktree');
    console.log('    cezar update --version <version> install a release or a PR preview (e.g. 0.13.0-pr1169.1234)');
    console.log('    cezar update --channel stable    go back to releases\n');
    return 0;
  }
  const status = await service.status({ refresh: true });
  if (!status.checkedAt) {
    console.error('  ✗ the npm registry did not answer — offline?');
    return 1;
  }
  const target = opts.version ?? (channel === 'stable' ? status.latest.stable : status.latest.nightly);
  if (!target) {
    console.error(`  ✗ no version published on the ${channel} channel`);
    return 1;
  }
  const active = status.installed.find((entry) => entry.active);
  console.log(`\n  cezar update — channel ${channel}, running ${status.version}${active ? ` (${active.id})` : ''}, target ${target}\n`);
  if (!opts.version && compareVersions(target, service.runningVersion) <= 0 && active?.source !== 'local') {
    console.log('  ✓ already up to date\n');
    return 0;
  }
  if (!status.canSelfUpdate) {
    // Not managed: install the target into the managed layout anyway, then explain the switch.
    console.log(`  ${status.reason ?? ''}\n  installing ${target} into the managed layout so \`cezar\` can run it:\n`);
  }
  try {
    const installed = findInstalled(target);
    const id = installed ? installed.id : (await installFromRegistry(target, { onLog: (line) => console.log(`  · ${line}`) })).id;
    activate(id);
    const pruned = await autoPruneVersions({ entry: service.entry });
    if (pruned && pruned.removed.length > 0) console.log(`  ✓ pruned ${pruned.removed.length} old version(s): ${pruned.removed.map((entry) => entry.id).join(', ')}`);
    const dir = writeLaunchers();
    console.log(`\n  ✓ ${id} is now current — start it with: ${isOnPath(dir) ? 'cezar' : `${dir}/cezar`}\n`);
    return 0;
  } catch (error) {
    console.error(`\n  ✗ update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function versionsCommand(): Promise<number> {
  const installed = listInstalled();
  if (installed.length === 0) {
    console.log('\n  no managed versions — run: cezar install (or `cezar link` in a built cezar checkout)\n');
    return 0;
  }
  console.log('');
  for (const entry of installed) {
    const where = entry.source === 'link' && entry.checkout ? `  → ${entry.checkout}` : '';
    console.log(`  ${entry.active ? '*' : ' '} ${entry.id.padEnd(36)} ${entry.source.padEnd(9)} ${entry.installedAt.slice(0, 19).replace('T', ' ')}${where}`);
  }
  const unlinked = (await discoverCheckouts().catch(() => [])).filter((checkout) => !checkout.linked);
  if (unlinked.length > 0) {
    console.log('\n  cezar worktrees (not linked yet — `cezar link <dir>` or pick one in the cockpit):');
    for (const checkout of unlinked) {
      console.log(`    ${checkout.branch.padEnd(34)} ${checkout.built ? 'built    ' : 'not built'} ${checkout.worktree}`);
    }
  }
  const backups = listVersionBackups();
  if (backups.length > 0) {
    console.log('\n  backups (remove with: cezar versions prune --backups):');
    for (const backup of backups) console.log(`    ${backup.path}`);
  }
  const registry = await new RegistryCache('@open-mercato/cezar').get();
  if (registry) {
    console.log(`\n  registry: stable ${registry.distTags[distTagFor('stable')] ?? '—'} · nightly ${registry.distTags[distTagFor('nightly')] ?? '—'}`);
  }
  console.log('\n  switch with: cezar use <id>  ·  remove old ones with: cezar versions prune\n');
  return 0;
}

export const VERSIONS_PRUNE_USAGE = `usage: cezar versions prune [--keep <n>] [--dry-run] [--backups]

  Remove old installs under ~/.cezar/versions, keeping the running version plus the
  most recently installed others (n in total). Never removes the active (\`current\`)
  version, one a running cezar uses, or a linked checkout, and does nothing while an
  install is in progress.

  --keep <n>   versions to keep, the running one included (default: versionRetention
               in ~/.cezar/config.json, else ${DEFAULT_VERSION_RETENTION})
  --dry-run    print what would be removed; remove nothing
  --backups    also remove ~/.cezar/versions.backup-* directories (never automatic)

  exit status: 0 done, 1 a removal failed or bad arguments, 3 skipped (an install
  in progress, or another prune or install holds the lock) — nothing was removed`;

/** `cezar versions prune` — the manual twin of the startup/post-update prune. */
export async function runVersionsPruneCommand(args: string[], opts: { entry: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  let values: { keep?: string; 'dry-run'?: boolean; backups?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        keep: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        backups: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}\n\n${VERSIONS_PRUNE_USAGE}`);
    return 1;
  }
  if (values.help) {
    console.log(VERSIONS_PRUNE_USAGE);
    return 0;
  }
  let keep: number;
  if (values.keep !== undefined) {
    keep = Number(values.keep);
    if (!/^\d+$/.test(values.keep) || keep < 1) {
      console.error(`  --keep must be a whole number of at least 1 (got ${values.keep})`);
      return 1;
    }
  } else {
    // A configured 0 turns off the AUTOMATIC prune; asking by hand still means the default.
    keep = (await configuredVersionRetention()) || DEFAULT_VERSION_RETENTION;
  }
  const result = await pruneVersions({ keep, dryRun: values['dry-run'], backups: values.backups, entry: opts.entry, env: opts.env });
  printPruneResult(result);
  if (result.failed.length > 0) return 1;
  return result.skipped && !result.dryRun ? 3 : 0;
}

export function printPruneResult(result: PruneResult): void {
  const verb = result.dryRun ? 'would remove' : 'removed';
  console.log(`\n  cezar versions prune — keep ${result.keep}${result.dryRun ? ' (dry run)' : ''}\n`);
  if (result.skipped) console.log(`  ! skipped: ${result.skipped}\n`);
  for (const entry of result.kept) console.log(`    keep    ${entry.id.padEnd(36)} ${entry.reason}`);
  for (const entry of result.removed) console.log(`  - ${result.dryRun ? 'remove ' : 'removed'} ${entry.id.padEnd(36)} installed ${entry.installedAt.slice(0, 10)}`);
  for (const failure of result.failed) console.log(`  ✗ failed  ${failure.id.padEnd(36)} ${failure.error}`);
  if (result.backups.length > 0) {
    console.log('\n  backups:');
    for (const backup of result.backups) {
      const state = backup.removed ? (result.dryRun ? 'would remove' : 'removed') : 'kept — remove with --backups';
      console.log(`    ${backup.path}  (${state})`);
    }
  }
  const backups = result.backups.filter((backup) => backup.removed).length;
  const summary = `${verb} ${result.removed.length} version(s)${backups > 0 ? ` and ${backups} backup(s)` : ''}`;
  console.log(`\n  ${result.dryRun ? '·' : '✓'} ${summary}${result.dryRun ? ' — run without --dry-run to delete' : ''}\n`);
}

async function useCommand(id: string | undefined): Promise<number> {
  if (!id) {
    console.error('  usage: cezar use <id>   (see: cezar versions)');
    return 1;
  }
  const match = listInstalled().find((entry) => entry.id === id || entry.version === id);
  if (!match) {
    console.error(`  ✗ ${id} is not installed — see: cezar versions`);
    return 1;
  }
  activate(match.id);
  console.log(`  ✓ now using ${match.id}`);
  return 0;
}

async function linkCommand(dir: string | undefined, use: boolean): Promise<number> {
  const target = resolve(dir ?? process.cwd());
  const packageRoot = cezarPackageRoot(target);
  if (!packageRoot) {
    console.error(`  ✗ ${target} is not a cezar checkout (no @open-mercato/cezar package.json there or in packages/cezar)`);
    return 1;
  }
  try {
    const branch = await branchOf(target);
    const result = linkCheckout(packageRoot, branch);
    console.log(`\n  ✓ linked ${result.id}  → ${packageRoot}`);
    if (use) {
      activate(result.id);
      console.log(`  ✓ now using ${result.id}`);
      console.log('    the desktop app picks it up on its next start (Cmd+Q, reopen) — a running cockpit keeps its version');
    } else {
      console.log(`    switch with: cezar use ${result.id}  ·  desktop: Cezar ▸ Versions  ·  cockpit: the version chip`);
    }
    console.log('    rebuild the checkout (npm run build) and restart to run new code — the link needs no refresh\n');
    return 0;
  } catch (error) {
    console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function unlinkCommand(id: string | undefined): Promise<number> {
  if (!id) {
    console.error('  usage: cezar unlink <id>   (see: cezar versions)');
    return 1;
  }
  const match = listLinks().find((entry) => entry.id === id || entry.checkout === resolve(id));
  if (!match) {
    console.error(`  ✗ ${id} is not a linked checkout — see: cezar versions`);
    return 1;
  }
  if (match.id === activeId()) {
    console.error(`  ✗ ${match.id} is the active version — \`cezar use <another id>\` first`);
    return 1;
  }
  removeInstalled(match.id);
  console.log(`  ✓ unlinked ${match.id} (${match.checkout ?? 'checkout'} is untouched)`);
  return 0;
}
