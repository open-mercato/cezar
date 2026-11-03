import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_PROJECT_ASSETS,
  type ProjectAsset,
  type ProjectAssetsResponse,
  type RunSubject,
} from '@open-mercato/cezar-contract';
import { scanArtifacts } from './artifacts.ts';
import type { RunRecord } from './store.ts';

/**
 * The project Assets page's listing (spec 2026-10-22-html-artifacts-and-impact, Phase 3). One
 * `readdir` of `artifacts/` decides which runs are scanned at all, so a run without a directory
 * costs nothing beyond that single read. Never throws: a missing, corrupt or vanished directory
 * contributes no rows.
 */
export async function listProjectAssets(
  dataDir: string,
  runs: readonly RunRecord[],
  staleFor: (subject: RunSubject) => Promise<boolean | null>,
): Promise<ProjectAssetsResponse> {
  let present: Set<string>;
  try {
    present = new Set(await readdir(join(dataDir, 'artifacts')));
  } catch {
    return { assets: [], truncated: false };
  }
  const staleBySubject = new Map<string, Promise<boolean | null>>();
  const stale = (subject: RunSubject) => {
    const key = subject.kind === 'pr' ? `pr:${subject.number}:${subject.headSha}` : `spec:${subject.path}:${subject.blobSha}`;
    let answer = staleBySubject.get(key);
    if (!answer) staleBySubject.set(key, (answer = staleFor(subject).catch(() => null)));
    return answer;
  };

  const rows: ProjectAsset[] = [];
  let truncated = false;
  for (const run of runs) {
    if (!present.has(run.id)) continue;
    const listing = await scanArtifacts(join(dataDir, 'artifacts', run.id));
    if (listing.artifacts.length === 0) continue;
    truncated ||= listing.truncated;
    const runStale = run.subject ? await stale(run.subject) : null;
    for (const artifact of listing.artifacts) {
      const kept = listing.versions?.filter((v) => v.files.includes(artifact.name)).length ?? 0;
      rows.push({
        runId: run.id,
        runTitle: run.titleSummary ?? run.title,
        runStatus: run.status,
        ...(run.subject ? { subject: run.subject } : {}),
        name: artifact.name,
        kind: artifact.kind,
        ...(artifact.title ? { title: artifact.title } : {}),
        size: artifact.size,
        updatedAt: artifact.updatedAt,
        versionCount: Math.max(1, kept),
        stale: runStale,
      });
    }
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.name.localeCompare(b.name)));
  return { assets: rows.slice(0, MAX_PROJECT_ASSETS), truncated: truncated || rows.length > MAX_PROJECT_ASSETS };
}
