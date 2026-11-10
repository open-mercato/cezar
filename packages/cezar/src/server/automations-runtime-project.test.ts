import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import type { RunManager } from '../workflows/run.ts';
import { startServer } from './server.ts';

/**
 * #2041: a project registered while the server runs, from ANOTHER process (`cez projects add`,
 * a config edit), never emits `project-added` in the server. Its automations must still arm,
 * not be skipped silently because the server's handle map only learned projects at boot.
 */
describe('automations on a project registered out of process (#2041)', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, automations: process.env.CEZ_AUTOMATIONS };
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-2041-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-2041-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-2041-other-'));
    execFileSync('git', ['init', '-q'], { cwd: otherRoot });
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(bootRoot, '.ai/cezar'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_AUTOMATIONS;
  });

  afterEach(() => {
    store.flush();
    vi.restoreAllMocks();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_AUTOMATIONS', saved.automations]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('arms an enabled automation created on that project, without a restart', async () => {
    let scheduler!: WorkspaceAutomationScheduler;
    const originalStart = WorkspaceAutomationScheduler.prototype.start;
    vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start').mockImplementation(async function (this: WorkspaceAutomationScheduler) {
      scheduler = this;
      await originalStart.call(this);
    });
    const server = startServer(
      { repoRoot: bootRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
      0,
    );
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      await vi.waitFor(() => expect(scheduler).toBeDefined(), { timeout: 4000, interval: 10 });
      expect(scheduler.hasTimer()).toBe(false);
      // What `cez projects add` does: a registry write, no HTTP, no in-process event.
      const project = await registerProject(otherRoot);
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/p/${project.id}/automations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nightly', enable: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump' } }),
      });
      expect(response.status).toBe(201);
      await vi.waitFor(() => expect(scheduler.hasTimer()).toBe(true), { timeout: 4000, interval: 10 });
    } finally {
      server.close();
    }
  });

  it('arms automations the project already had enabled, once the cockpit opens it', async () => {
    let scheduler!: WorkspaceAutomationScheduler;
    const originalStart = WorkspaceAutomationScheduler.prototype.start;
    vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start').mockImplementation(async function (this: WorkspaceAutomationScheduler) {
      scheduler = this;
      await originalStart.call(this);
    });
    // Enabled before cezar ever heard of the project: no automation edit will follow.
    AutomationStore.open(join(otherRoot, '.ai/cezar')).create(
      { name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump' } },
      'nightly',
    );
    const server = startServer(
      { repoRoot: bootRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
      0,
    );
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      await vi.waitFor(() => expect(scheduler).toBeDefined(), { timeout: 4000, interval: 10 });
      expect(scheduler.hasTimer()).toBe(false);
      const project = await registerProject(otherRoot);
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/p/${project.id}/automations`);
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(scheduler.hasTimer()).toBe(true), { timeout: 4000, interval: 10 });
    } finally {
      server.close();
    }
  });
});
