import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitUsageForTest, type ProcessUsage } from '../core/process-usage.js';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.js';
import { ProjectContexts } from './project-context.js';
import { apiRequest } from './loopback-request.testkit.js';
import { createApp } from './server.js';

/**
 * Per-project `usage` SSE scoping (spec 2026-07-20-multi-project-workspace,
 * step 2.4): the process-usage sampler is module-global, so one snapshot
 * carries EVERY project's runs. The relay must SPLIT the per-run-keyed
 * payload by each project's owned runIds — project A's stream never sees
 * project B's samples, and the payload is filtered, never stamped with a
 * project field.
 */
describe('usage SSE fan-out is scoped per project', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;
  let bootRunId: string;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-usage-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-usage-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-usage-other-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1';
    for (const root of [repoRoot, otherRoot]) {
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
      writeFileSync(join(root, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    bootRunId = store.createRun({
      title: 'boot',
      workflow: 'quick-task',
      task: 'boot',
      steps: [],
    }).id;
    contexts = new ProjectContexts({ listProjects });
    await registerProject(repoRoot);
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** Open one SSE stream and return an incremental until-reader. */
  const openStream = async (url: string): Promise<{ readUntil: (marker: string) => Promise<string> }> => {
    const res = await apiRequest(app, url);
    expect(res.status, url).toBe(200);
    expect(res.body, url).not.toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    closers.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let body = '';
    return {
      async readUntil(marker: string): Promise<string> {
        const deadline = Date.now() + 5_000;
        while (!body.includes(marker) && Date.now() < deadline) {
          const timeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())),
          );
          const next = await Promise.race([reader.read(), timeout]);
          if (next === null || next.done) break;
          body += decoder.decode(next.value, { stream: true });
        }
        expect(body, `${url} never delivered ${JSON.stringify(marker)}`).toContain(marker);
        return body;
      },
    };
  };

  /** All `usage` payloads delivered so far, in arrival order. */
  const usagePayloads = (body: string): Array<Record<string, ProcessUsage>> =>
    [...body.matchAll(/event: usage\ndata: (.*)\n/g)].map(
      (m) => JSON.parse(m[1] as string) as Record<string, ProcessUsage>,
    );

  it("each project's stream carries only its own runs from a shared snapshot", async () => {
    // Build the second project's context lazily (first API touch), then give
    // its store a run of its own.
    const other = await registerProject(otherRoot);
    expect((await apiRequest(app, `/api/p/${other.id}/runs`)).status).toBe(200);
    const otherStore = contexts.peek(other.id)?.store;
    expect(otherStore).toBeDefined();
    const otherRunId = (otherStore as RunStore).createRun({
      title: 'other',
      workflow: 'quick-task',
      task: 'other',
      steps: [],
    }).id;

    const bootStream = await openStream('/api/events'); // legacy alias = boot project
    const otherStream = await openStream(`/api/p/${other.id}/events`);
    // The first ping is written after the handler subscribed to the sampler —
    // once it arrives, the fan-out below is guaranteed to reach the stream.
    await bootStream.readUntil('event: ping');
    await otherStream.readUntil('event: ping');

    const bootSample: ProcessUsage = {
      cpuPct: 12.5,
      rssBytes: 111 * 1024,
      procCount: 2,
    };
    const otherSample: ProcessUsage = {
      cpuPct: 99.9,
      rssBytes: 222 * 1024,
      procCount: 5,
    };
    emitUsageForTest({ [bootRunId]: bootSample, [otherRunId]: otherSample });

    const bootBody = await bootStream.readUntil('event: usage');
    const otherBody = await otherStream.readUntil('event: usage');

    // Boot's stream: only the boot run — B's sample never crosses.
    expect(usagePayloads(bootBody)).toEqual([{ [bootRunId]: bootSample }]);
    // The other project's stream: only its own run — never boot's.
    expect(usagePayloads(otherBody)).toEqual([{ [otherRunId]: otherSample }]);
  });

  it('a snapshot owned entirely by another project arrives as an empty record (stale samples clear)', async () => {
    const other = await registerProject(otherRoot);
    expect((await apiRequest(app, `/api/p/${other.id}/runs`)).status).toBe(200);

    const otherStream = await openStream(`/api/p/${other.id}/events`);
    await otherStream.readUntil('event: ping');

    // Every run in the snapshot belongs to the boot project.
    emitUsageForTest({
      [bootRunId]: { cpuPct: 1, rssBytes: 1024, procCount: 1 },
    });

    const body = await otherStream.readUntil('event: usage');
    // Same tick cadence as before scoping, but no foreign rows — the client
    // treats `{}` as "no live usage" and clears any stale rows.
    expect(usagePayloads(body)).toEqual([{}]);
  });
});
