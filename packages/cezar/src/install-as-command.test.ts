import { describe, expect, it } from 'vitest';
import {
  BIN_NAMES,
  PACKAGE_NAME,
  globalBinDir,
  globalShimPaths,
  planInstall,
} from './install-as-command.js';

// The decisions behind `npm run install-as-command` (scripts/install-as-command.mjs):
// which npm command runs per mode, and where the global bin shims land. Spec 013.
describe('planInstall', () => {
  it('link mode builds first, then `npm link`', () => {
    const plan = planInstall({ mode: 'link' });
    expect(plan.build).toBe(true);
    expect(plan.steps.map((s) => s.args)).toEqual([['link']]);
  });

  it('global mode builds first, then `npm install --global .`', () => {
    const plan = planInstall({ mode: 'global' });
    expect(plan.build).toBe(true);
    expect(plan.steps.map((s) => s.args)).toEqual([['install', '--global', '.']]);
  });

  it('uninstall never builds and removes the scoped package globally', () => {
    const plan = planInstall({ mode: 'uninstall' });
    expect(plan.build).toBe(false);
    expect(plan.steps.map((s) => s.args)).toEqual([['rm', '--global', PACKAGE_NAME]]);
  });

  it('honors an explicit build:false for the install flavors (--no-build)', () => {
    expect(planInstall({ mode: 'link', build: false }).build).toBe(false);
    expect(planInstall({ mode: 'global', build: false }).build).toBe(false);
  });

  it('cannot be told to build on uninstall', () => {
    expect(planInstall({ mode: 'uninstall', build: true }).build).toBe(false);
  });
});

describe('globalShimPaths', () => {
  it('maps all three bins under <prefix>/bin on POSIX', () => {
    expect(globalShimPaths('/usr/local', 'linux')).toEqual([
      '/usr/local/bin/cezar',
      '/usr/local/bin/cez',
      '/usr/local/bin/cezar-cli',
    ]);
  });

  it('uses <prefix>\\<name>.cmd on Windows', () => {
    expect(globalShimPaths('C:\\npm-global', 'win32')).toEqual([
      'C:\\npm-global\\cezar.cmd',
      'C:\\npm-global\\cez.cmd',
      'C:\\npm-global\\cezar-cli.cmd',
    ]);
  });

  it('covers exactly the published bin names', () => {
    expect(globalShimPaths('/p', 'linux')).toHaveLength(BIN_NAMES.length);
  });
});

describe('globalBinDir', () => {
  it('is <prefix>/bin on POSIX and the prefix itself on Windows', () => {
    expect(globalBinDir('/usr/local', 'linux')).toBe('/usr/local/bin');
    expect(globalBinDir('C:\\npm-global', 'win32')).toBe('C:\\npm-global');
  });
});
