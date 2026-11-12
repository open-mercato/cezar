import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationDefinition } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { stripTaskMarkers } from '../runs/task-markers.ts';
import type { AutomationRunReport } from './engine.ts';

/**
 * Posts a linked automation's finished runs to its manager's chat (spec 2026-10-31-managers
 * § Automation reports). One listener per project run store; the engine owns idempotency.
 */

export interface AutomationReportWatch {
  /** The project's id as `[[task:…]]` cards name it; async because the boot id resolves late. */
  projectId: () => string | Promise<string>;
  dataDir: string;
  store: RunStore;
  automation: (id: string) => AutomationDefinition | undefined;
  report: (input: AutomationRunReport) => 'posted' | 'duplicate' | 'skipped' | 'gone';
  /** The linked manager is gone: drop the link quietly. */
  unlink: (automationId: string) => void;
  /** `CEZ_MANAGERS=0` posts nothing. */
  enabled: () => boolean;
  timeZone?: string;
}

const SUCCESS = new Set<RunRecord['status']>(['review', 'done']);
const SETTLED = new Set<RunRecord['status']>(['review', 'done', 'failed', 'cancelled']);
const TAIL_BYTES = 512 * 1024;
const TEXT_LIMIT = 60_000;

export const automationIdOf = (run: RunRecord): string | undefined =>
  run.automationTrigger?.automationId ?? run.automation?.automationId ?? run.automationTracker?.automationId;

/** The run's last assistant message, whole, minus `CEZ:` control lines. */
export function finalAssistantText(dataDir: string, runId: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(join(dataDir, 'runs', `${runId}.ndjson`), 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.includes('"type":"text"')) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown; text?: unknown };
        if (event.type !== 'text' || typeof event.text !== 'string') continue;
        const text = stripTaskMarkers(event.text).replace(/^[ \t]*CEZ:(?:DONE|MONITORING)[ \t]*$/gm, '').trim();
        return text ? text.slice(0, TEXT_LIMIT) : undefined;
      } catch {
        // a torn first line of the window
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The keys `taskAttention` gives this run, so the watch does not report it again. */
const attentionKeys = (projectId: string, run: RunRecord): string[] =>
  ['task-finished', 'task-review', 'task-failed'].map((kind) => `${kind}:${projectId}:${run.id}:${run.finishedAt}`);

function resumeLabel(at: string | undefined, timeZone: string | undefined): string | undefined {
  const ms = Date.parse(at ?? '');
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
}

/** A baseline at attach: only a status change seen here reports, never history. Returns the unsubscribe. */
export function watchAutomationReports(watch: AutomationReportWatch): () => void {
  const seen = new Map(watch.store.listRuns().map((run) => [run.id, run.status] as const));
  const onRun = (run: RunRecord) => {
    const before = seen.get(run.id);
    seen.set(run.id, run.status);
    if (before === run.status || !SETTLED.has(run.status) || run.status === 'cancelled') return;
    // review → done is the same success, a dispatched child reports to its parent.
    if (before !== undefined && SUCCESS.has(before) && SUCCESS.has(run.status)) return;
    if (run.dispatch?.parentRunId) return;
    const automationId = automationIdOf(run);
    if (!automationId || !watch.enabled()) return;
    const definition = watch.automation(automationId);
    if (!definition?.report || definition.report.mode === 'none') return;
    const { report } = definition;
    const outcome = SUCCESS.has(run.status) ? 'success' : 'failure';
    // Off the store's emit: the run's final events and index write land first.
    setImmediate(() => {
      void Promise.resolve(watch.projectId()).then((projectId) => {
        const text = outcome === 'success' ? finalAssistantText(watch.dataDir, run.id) : undefined;
        const resumesAt = outcome === 'failure' ? resumeLabel(run.autoResumeAt, watch.timeZone) : undefined;
        const result = watch.report({
          managerId: report.managerId,
          mode: report.mode,
          projectId,
          automationId,
          automationName: definition.name,
          runId: run.id,
          outcome,
          ...(text ? { text } : {}),
          ...(outcome === 'failure' && run.error ? { reason: run.error } : {}),
          ...(resumesAt ? { resumesAt } : {}),
          attentionKeys: attentionKeys(projectId, run),
        });
        if (result === 'gone') watch.unlink(automationId);
      }).catch((error) => console.warn(`[cezar] automation report for ${run.id}: ${error instanceof Error ? error.message : String(error)}`));
    });
  };
  watch.store.on('run', onRun);
  return () => {
    watch.store.off('run', onRun);
  };
}
