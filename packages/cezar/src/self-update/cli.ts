/**
 * `cezar install | update | versions | use | link | unlink` — the terminal side of the managed
 * install. No server, no repo: only `~/.cezar` and the npm registry. The cockpit's dialog drives
 * the same service; this is what a headless box or a shell-only user gets.
 */

import { resolve } from 'node:path';

import { branchOf, cezarPackageRoot, discoverCheckouts } from './checkouts.ts';
import { activate, activeId, findInstalled, linkCheckout, listInstalled, listLinks, removeInstalled } from './layout.ts';
import { ensurePathHook, isOnPath, writeLaunchers } from './launcher.ts';
import { installFromRegistry } from './installer.ts';
import { distTagFor, RegistryCache } from './registry.ts';
import { compareVersions } from './semver.ts';
import type { SelfUpdateService } from './service.ts';

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
    console.log('    cezar update <version>           install a release or a PR preview (e.g. 0.13.0-pr1169.1234)');
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
  if (!opts.version && compareVersions(target, status.version) <= 0 && active?.source !== 'local') {
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
  const registry = await new RegistryCache('@open-mercato/cezar').get();
  if (registry) {
    console.log(`\n  registry: stable ${registry.distTags[distTagFor('stable')] ?? '—'} · nightly ${registry.distTags[distTagFor('nightly')] ?? '—'}`);
  }
  console.log('\n  switch with: cezar use <id>\n');
  return 0;
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
