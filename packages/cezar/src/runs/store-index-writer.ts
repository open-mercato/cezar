import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { renameSyncWithRetry } from '../fs-rename.ts';
import { lockRunIndex, runRecordSchema, type RunRecord } from './store.ts';

interface RunIndexWriteRequest {
  dataDir: string;
  runs: Array<{ run: RunRecord; baseline?: string }>;
  deleted: string[];
  pretty: boolean;
}

const request = workerData as RunIndexWriteRequest;
const indexPath = join(request.dataDir, 'runs.json');
const tmpPath = join(request.dataDir, 'runs', `.index-${process.pid}-${randomUUID()}.tmp`);
let release: (() => void) | undefined;

try {
  release = lockRunIndex(request.dataDir);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { raw = undefined; }
  const merged = new Map<string, RunRecord>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const id: unknown = (entry as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || request.deleted.includes(id)) continue;
      const parsed = runRecordSchema.safeParse(entry);
      if (parsed.success) merged.set(id, parsed.data);
    }
  }

  for (const { run, baseline: beforeJson } of request.runs) {
    const disk = merged.get(run.id);
    if (!beforeJson || !disk || disk.createdAt !== run.createdAt) {
      merged.set(run.id, run);
      continue;
    }
    const before = JSON.parse(beforeJson) as Record<string, unknown>;
    const local = run as unknown as Record<string, unknown>;
    const combined = { ...disk } as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(local)])) {
      if (JSON.stringify(local[key]) === JSON.stringify(before[key])) continue;
      if (key in local) combined[key] = local[key];
      else delete combined[key];
    }
    merged.set(run.id, combined as RunRecord);
  }

  const rows = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  writeFileSync(tmpPath, JSON.stringify(rows, null, request.pretty ? 2 : undefined), 'utf8');
  renameSyncWithRetry(tmpPath, indexPath);
  parentPort?.postMessage({ ok: true, baselines: request.runs.map(({ run }) => [run.id, JSON.stringify(merged.get(run.id))]) });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  try { rmSync(tmpPath, { force: true }); } catch { /* best effort after atomic replacement */ }
  try { release?.(); } catch { /* the writer ticket is retried by its owner */ }
  parentPort?.close();
}
