/**
 * `cezar install | update | versions | use` — the terminal side of the managed install. No
 * server, no repo: only `~/.cezar` and the npm registry. The cockpit's dialog drives the same
 * service; this is what a headless box or a shell-only user gets.
 */

import { activate, findInstalled, listInstalled } from './layout.ts';
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
  if (requested !== undefined && requested !== 'stable' && requested !== 'nightly') {
    console.error(`  --channel must be stable or nightly (got ${requested})`);
    return 1;
  }
  if (requested) await service.setChannel(requested);
  const channel = await service.channel();
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
    console.log('\n  no managed versions — run: cezar install\n');
    return 0;
  }
  console.log('');
  for (const entry of installed) {
    console.log(`  ${entry.active ? '*' : ' '} ${entry.id.padEnd(36)} ${entry.source.padEnd(9)} ${entry.installedAt.slice(0, 19).replace('T', ' ')}`);
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
