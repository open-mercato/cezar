import { describe, expect, it } from 'vitest';
import { detectContainerRuntime, parseMachines } from './container-probe.ts';

describe('container runtime probe', () => {
  it('distinguishes "not installed" from "installed but VM stopped"', async () => {
    // The two need different words and different fixes — collapsing them into
    // one boolean is what makes an isolation toggle unexplainable.
    const missing = await detectContainerRuntime('definitely-not-a-binary', 'darwin');
    expect(missing.ready).toBe(false);
    expect(missing.installed).toBe(false);
    expect(missing.reason).toMatch(/not installed/);
    expect(missing.fix).toMatch(/brew install podman/);
  });

  it('refuses Windows up front rather than letting mounts fail later', async () => {
    // Same-absolute-path mounting is the design's foundation and cannot hold
    // for `C:\...`. Saying "ready" would hand someone silently wrong mounts.
    const s = await detectContainerRuntime('echo', 'win32');
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/Windows/);
    expect(s.fix).toBeUndefined();
  });

  it('on linux there is no VM, so installed means ready', async () => {
    const s = await detectContainerRuntime('echo', 'linux');
    expect(s.installed).toBe(true);
    expect(s.machineRunning).toBe(true);
    expect(s.ready).toBe(true);
    expect(s.reason).toBe('');
  });

  it('reads a running machine out of `machine list --format json`', () => {
    expect(parseMachines('[{"Name":"podman-machine-default","Running":true}]'))
      .toEqual({ running: true, name: 'podman-machine-default' });
  });

  it('a stopped machine is named, so the message can name it', () => {
    expect(parseMachines('[{"Name":"podman-machine-default","Running":false}]'))
      .toEqual({ running: false, name: 'podman-machine-default' });
  });

  it('no machines, and unparseable output, both mean "not running" — never a throw', () => {
    // This runs on a settings page load; an exception here is a broken page.
    expect(parseMachines('[]')).toEqual({ running: false });
    expect(parseMachines('not json at all')).toEqual({ running: false });
    expect(parseMachines('')).toEqual({ running: false });
  });
});
